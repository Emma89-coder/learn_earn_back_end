const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_me';
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');

// ============ RAG IMPORTS ============
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');

// ============ FIXED PDF PARSER IMPORT ============
let pdfParse;
try {
  const pdfParseModule = require('pdf-parse');
  pdfParse = pdfParseModule.default || pdfParseModule;
  console.log('✅ PDF Parse loaded successfully');
} catch (error) {
  console.error('❌ Failed to load pdf-parse:', error.message);
  pdfParse = null;
}

// ============ INITIALIZE EXPRESS APP ============
const app = express();

// ============ RAG CLIENTS ============
let pineconeClient = null;
let openaiClient = null;

// ============ SUPABASE CLIENT (declared but initialized later) ============
let supabase;

// ============ CORS ============
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://learnearn-one.vercel.app',
  'https://learnearn-one-git-*.vercel.app'
];

const isAllowedOrigin = (origin) => {
  if (!origin) return true;

  if (allowedOrigins.includes(origin)) return true;

  return /^https:\/\/learnearn-one(?:-git-[a-z0-9-]+)?\.vercel\.app$/.test(origin);
};

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ============ REQUEST LOGGING ============
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.url}`);
  next();
});

// ============ CLOUDFLARE R2 ============
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  },
});

const uploadToR2 = async (buffer, fileName, mimeType) => {
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.CLOUDFLARE_R2_BUCKET,
      Key: fileName,
      Body: buffer,
      ContentType: mimeType,
      CacheControl: 'public, max-age=31536000',
    });
    await r2Client.send(command);
    const url = `${process.env.CLOUDFLARE_PUBLIC_URL}/${fileName}`;
    return { success: true, url };
  } catch (error) {
    console.error('Error uploading to R2:', error);
    return { success: false, error: error.message };
  }
};

const deleteFromR2 = async (fileName) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: process.env.CLOUDFLARE_R2_BUCKET,
      Key: fileName,
    });
    await r2Client.send(command);
    return { success: true };
  } catch (error) {
    console.error('Error deleting from R2:', error);
    return { success: false, error: error.message };
  }
};

// Multer configuration
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|pdf|text\/csv|application\/vnd.ms-excel|csv|docx|txt|md|json/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only images, PDF, CSV, DOCX, TXT, MD, and JSON files are allowed'));
    }
  }
});

// ============ AUTH MIDDLEWARE ============
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  const role = String(req.user?.role || '').toLowerCase();
  if (!role || !role.includes('admin')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ============ AI ROUTES ============
const aiRoutes = require('./routes/admin/ai');
app.use('/api/ai', aiRoutes);

// ============ ELEVENLABS TTS ============
app.post('/api/tts/speak', authenticateToken, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Text is required' });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'HKFOb9iktHA85uKXydRT';

    if (!apiKey || apiKey === 'your_elevenlabs_api_key_here') {
      return res.status(503).json({ success: false, error: 'ElevenLabs API key not configured' });
    }

    // Call ElevenLabs TTS API
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: text.substring(0, 500),
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.3,
          use_speaker_boost: true,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('ElevenLabs error:', response.status, errorText);
      return res.status(response.status).json({
        success: false,
        error: `ElevenLabs error: ${response.status}`
      });
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=86400',
    });
    
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));

  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate speech' });
  }
});

// ============ INITIALIZE RAG CLIENTS ============
const initRAGClients = async () => {
  try {
    // Initialize OpenAI
    if (process.env.OPENAI_API_KEY) {
      openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      console.log('✅ OpenAI client initialized');
    } else {
      console.log('⚠️ OPENAI_API_KEY not found in .env');
    }

    // Initialize Pinecone
    if (process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX) {
      pineconeClient = new Pinecone({
        apiKey: process.env.PINECONE_API_KEY,
      });
      console.log('✅ Pinecone client initialized');
      
      // Check if index exists
      try {
        const indexList = await pineconeClient.listIndexes();
        const indexes = indexList.indexes || [];
        const indexExists = indexes.some(idx => idx.name === process.env.PINECONE_INDEX);
        
        if (!indexExists) {
          console.log(`⚠️ Pinecone index "${process.env.PINECONE_INDEX}" not found. Creating...`);
          await pineconeClient.createIndex({
            name: process.env.PINECONE_INDEX,
            dimension: 1024,
            metric: 'cosine',
            spec: {
              serverless: {
                cloud: 'aws',
                region: 'us-west-2'
              }
            }
          });
          console.log(`✅ Pinecone index "${process.env.PINECONE_INDEX}" created`);
        } else {
          console.log(`✅ Pinecone index "${process.env.PINECONE_INDEX}" found`);
        }
      } catch (pineconeError) {
        console.error('❌ Pinecone error:', pineconeError.message);
      }
    } else {
      console.log('⚠️ Pinecone not configured - RAG features will be limited');
      if (!process.env.PINECONE_API_KEY) console.log('   - PINECONE_API_KEY missing');
      if (!process.env.PINECONE_INDEX) console.log('   - PINECONE_INDEX missing');
    }
  } catch (error) {
    console.error('❌ Failed to initialize RAG clients:', error.message);
  }
};

// ============ REGISTER SETTINGS ROUTE ============
// IMPORTANT: This must be registered AFTER supabase is initialized
// but BEFORE the server starts listening
const adminSettingsRoutes = require('./routes/admin/settings');

// ============================================
// ALL ROUTE REGISTRATIONS GO HERE
// ============================================

// ============ RAG (AI INTELLIGENCE) ENDPOINTS ============

// Health check for RAG service
app.get('/api/admin/rag/health', authenticateToken, requireAdmin, async (req, res) => {
  const status = {
    success: true,
    services: {
      openai: !!openaiClient,
      pinecone: !!pineconeClient,
    },
    config: {
      openaiKey: process.env.OPENAI_API_KEY ? 'Set' : 'Missing',
      pineconeKey: process.env.PINECONE_API_KEY ? 'Set' : 'Missing',
      pineconeIndex: process.env.PINECONE_INDEX || 'Not set',
    },
    tables: {
      rag_documents: false,
      rag_queries: false,
    },
    pineconeIndexExists: false,
    message: []
  };

  // Check if tables exist
  try {
    const { data: docCheck, error: docErr } = await supabase
      .from('rag_documents')
      .select('id')
      .limit(1);
    status.tables.rag_documents = !docErr;
    if (docErr) status.message.push('Table rag_documents not found. Run migration 002_create_rag_tables.sql.');
  } catch (error) {
    status.tables.rag_documents = false;
    status.message.push('Table rag_documents not found. Run SQL migration.');
  }

  try {
    const { data: queryCheck, error: queryErr } = await supabase
      .from('rag_queries')
      .select('id')
      .limit(1);
    status.tables.rag_queries = !queryErr;
    if (queryErr) status.message.push('Table rag_queries not found. Run migration 002_create_rag_tables.sql.');
  } catch (error) {
    status.tables.rag_queries = false;
    status.message.push('Table rag_queries not found. Run SQL migration.');
  }

  // Check Pinecone index
  if (pineconeClient) {
    try {
      const indexList = await pineconeClient.listIndexes();
      const availableIndexes = indexList.indexes || [];
      status.pineconeIndexExists = availableIndexes.some(idx => idx.name === process.env.PINECONE_INDEX);
      if (!status.pineconeIndexExists) {
        status.message.push(`Pinecone index "${process.env.PINECONE_INDEX}" not found. Create it in Pinecone dashboard.`);
      }
    } catch (error) {
      status.message.push(`Pinecone error: ${error.message}`);
    }
  }

  res.json(status);
});

// Helper: generate simple fallback embeddings when OpenAI is unavailable
const generateFallbackEmbeddings = (chunks) => {
  return chunks.map((chunk, i) => {
    const vector = new Array(1024).fill(0);
    for (let c = 0; c < chunk.length; c++) {
      const idx = (chunk.charCodeAt(c) * (c + 1)) % 1024;
      vector[idx] += 1 / chunk.length;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    const normalized = magnitude > 0 ? vector.map(v => v / magnitude) : vector;
    return { embedding: normalized, index: i };
  });
};

const buildPineconeDocumentFilter = async (documentId) => {
  if (!documentId) return undefined;

  const { data: doc, error } = await supabase
    .from('rag_documents')
    .select('name')
    .eq('id', documentId)
    .single();

  if (error || !doc) return undefined;

  return {
    $or: [
      { documentId: { $eq: String(documentId) } },
      { source: { $eq: doc.name } }
    ]
  };
};

// Upload documents for RAG processing
app.post('/api/admin/rag/upload', authenticateToken, requireAdmin, upload.array('documents', 10), async (req, res) => {
  console.log('📤 RAG Upload request received');

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files provided. Please select at least one file.'
      });
    }

    console.log(`📁 Received ${req.files.length} file(s)`);
    req.files.forEach(f => console.log(`   - ${f.originalname} (${f.size} bytes, ${f.mimetype})`));

    // Check services — allow upload even without OpenAI (will use fallback embeddings)
    if (!openaiClient) {
      console.log('⚠️ OpenAI not configured — will use fallback embeddings');
    }

    if (!pineconeClient) {
      return res.status(503).json({
        success: false,
        message: 'Pinecone service is not configured. Check PINECONE_API_KEY in .env'
      });
    }

    // Check Pinecone index exists
    try {
      const indexList = await pineconeClient.listIndexes();
      const availableIndexes = indexList.indexes || [];
      const indexExists = availableIndexes.some(idx => idx.name === process.env.PINECONE_INDEX);
      if (!indexExists) {
        return res.status(503).json({
          success: false,
          message: `Pinecone index "${process.env.PINECONE_INDEX}" does not exist.`,
          details: { availableIndexes: availableIndexes.map(idx => idx.name) }
        });
      }
    } catch (error) {
      return res.status(503).json({
        success: false,
        message: 'Failed to connect to Pinecone: ' + error.message
      });
    }

    const results = [];
    const errors = [];

    for (const file of req.files) {
      try {
        let text = '';
        const fileExt = path.extname(file.originalname).toLowerCase();

        // Extract text based on file type
        if (file.mimetype === 'application/pdf' || fileExt === '.pdf') {
          if (!pdfParse) {
            errors.push({ name: file.originalname, error: 'PDF parser not available. Install pdf-parse.' });
            continue;
          }
          const data = await pdfParse(file.buffer);
          text = data.text;
          console.log(`📄 Extracted ${text.length} chars from PDF`);
        } else if (file.mimetype === 'text/plain' || fileExt === '.txt' || fileExt === '.md') {
          text = file.buffer.toString('utf-8');
          console.log(`📄 Extracted ${text.length} chars from text file`);
        } else if (file.mimetype === 'application/json' || fileExt === '.json') {
          const jsonData = JSON.parse(file.buffer.toString('utf-8'));
          text = JSON.stringify(jsonData, null, 2);
          console.log(`📄 Extracted ${text.length} chars from JSON`);
        } else if (file.mimetype === 'text/csv' || fileExt === '.csv') {
          text = file.buffer.toString('utf-8');
          console.log(`📄 Extracted ${text.length} chars from CSV`);
        } else {
          text = file.buffer.toString('utf-8');
          console.log(`📄 Extracted ${text.length} chars from ${file.mimetype}`);
        }

        if (!text || text.trim().length < 10) {
          errors.push({
            name: file.originalname,
            error: 'No text content extracted. File may be empty or unreadable.'
          });
          continue;
        }

        // Split into chunks
        const chunkSize = 500;
        const overlap = 50;
        const chunks = [];
        for (let i = 0; i < text.length; i += chunkSize - overlap) {
          const chunk = text.substring(i, i + chunkSize);
          if (chunk.trim().length > 20) chunks.push(chunk);
        }

        if (chunks.length === 0) {
          errors.push({
            name: file.originalname,
            error: 'No valid chunks created. Text may be too short.'
          });
          continue;
        }

        console.log(`✅ Created ${chunks.length} chunks from ${file.originalname}`);

        // Create DB record first so vectors can reference a stable document id
        const { data: docData, error: docError } = await supabase
          .from('rag_documents')
          .insert([{
            name: file.originalname,
            type: file.mimetype || 'application/octet-stream',
            size: file.size,
            chunks: chunks.length,
            word_count: text.split(/\s+/).length,
            status: 'pending',
            user_id: parseInt(req.user.id) || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }])
          .select()
          .single();

        if (docError) {
          console.error('❌ Database error:', docError);
          errors.push({
            name: file.originalname,
            error: `Database save failed: ${docError.message}. Ensure the rag_documents table exists (run migration 002_create_rag_tables.sql in Supabase).`
          });
          continue;
        }

        // Generate embeddings — try OpenAI first, fall back to simple vectors if quota exceeded
        let allEmbeddings = [];
        
        if (openaiClient) {
          try {
            // Try OpenAI embeddings in batches
            const EMBED_BATCH = 100;
            for (let b = 0; b < chunks.length; b += EMBED_BATCH) {
              const batchChunks = chunks.slice(b, b + EMBED_BATCH);
              console.log(`   🔄 Embedding batch ${Math.floor(b / EMBED_BATCH) + 1} (${batchChunks.length} chunks)...`);
              const embedResponse = await openaiClient.embeddings.create({
                model: 'text-embedding-3-small',
                input: batchChunks,
                dimensions: 1024,
              });
              allEmbeddings.push(...embedResponse.data);
            }
          } catch (embedError) {
            console.error('   ❌ OpenAI embedding failed:', embedError.message || embedError);
            
            // If quota exceeded (429), rate limited, or any OpenAI billing error — use fallback
            const errStatus = embedError.status || embedError.response?.status || embedError.code;
            const errMsg = (embedError.message || '').toLowerCase();
            const isQuotaError = errStatus === 429 || errStatus === '429' ||
              errMsg.includes('quota') || errMsg.includes('rate') ||
              errMsg.includes('billing') || errMsg.includes('exceeded') ||
              errMsg.includes('insufficient');
            
            if (isQuotaError) {
              console.log('   ⚠️ OpenAI quota/rate error. Using fallback embeddings...');
              allEmbeddings = generateFallbackEmbeddings(chunks);
            } else {
              await supabase
                .from('rag_documents')
                .update({ status: 'failed', updated_at: new Date().toISOString() })
                .eq('id', docData.id);
              errors.push({
                name: file.originalname,
                error: `Embedding failed: ${embedError.message}`
              });
              continue;
            }
          }
        } else {
          // No OpenAI configured at all — use fallback
          console.log('   ⚠️ No OpenAI client. Using fallback embeddings...');
          allEmbeddings = generateFallbackEmbeddings(chunks);
        }

        // Validate embeddings
        if (!allEmbeddings || allEmbeddings.length === 0) {
          await supabase
            .from('rag_documents')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', docData.id);
          errors.push({
            name: file.originalname,
            error: 'No embeddings generated. Check OpenAI configuration.'
          });
          continue;
        }

        // Prepare vectors for Pinecone
        const timestamp = Date.now();
        const safeFileName = file.originalname.replace(/[^a-zA-Z0-9]/g, '_');
        const vectors = allEmbeddings
          .map((e, i) => ({
            id: `${safeFileName}_${i}_${timestamp}`,
            values: e.embedding,
            metadata: {
              text: chunks[i] || '',
              source: file.originalname,
              documentId: String(docData.id),
              chunkIndex: i,
              totalChunks: chunks.length,
              uploadedAt: new Date().toISOString(),
            },
          }))
          .filter(v => v.values && v.values.length > 0);

        if (vectors.length === 0) {
          await supabase
            .from('rag_documents')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', docData.id);
          errors.push({
            name: file.originalname,
            error: 'No valid vectors created. Check embedding generation.'
          });
          continue;
        }

        console.log(`💾 Storing ${vectors.length} vectors in Pinecone (dim: ${vectors[0]?.values?.length || 'unknown'})...`);

        // Upsert to Pinecone in batches of 100 (Pinecone hard limit)
        const PINECONE_BATCH = 100;
        const index = pineconeClient.index(process.env.PINECONE_INDEX);
        for (let b = 0; b < vectors.length; b += PINECONE_BATCH) {
          const batch = vectors.slice(b, b + PINECONE_BATCH);
          await index.upsert(batch);
        }

        console.log(`✅ Successfully stored ${vectors.length} vectors`);

        const { error: updateError } = await supabase
          .from('rag_documents')
          .update({
            status: 'processed',
            chunks: chunks.length,
            word_count: text.split(/\s+/).length,
            updated_at: new Date().toISOString(),
          })
          .eq('id', docData.id);

        if (updateError) {
          console.error('❌ Database update error:', updateError);
          errors.push({
            name: file.originalname,
            error: `Database update failed: ${updateError.message}`
          });
          continue;
        }

        console.log(`✅ Successfully saved ${file.originalname} to database`);
        results.push({
          name: file.originalname,
          status: 'processed',
          chunks: chunks.length,
          word_count: text.split(/\s+/).length,
          id: docData.id
        });

      } catch (error) {
        console.error(`❌ Error processing ${file.originalname}:`, error);
        errors.push({
          name: file.originalname,
          error: error.message
        });
      }
    }

    // Return response
    const uploadResponse = {
      success: true,
      results,
      errors: errors.length > 0 ? errors : undefined,
      total: req.files.length,
      processed: results.length,
      failed: errors.length,
      message: `Processed ${results.length} of ${req.files.length} files successfully.`
    };

    if (errors.length > 0) {
      uploadResponse.message += ` ${errors.length} file(s) failed. Check errors for details.`;
    }

    console.log('📊 Upload complete:', uploadResponse);
    res.json(uploadResponse);

  } catch (error) {
    console.error('❌ RAG upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload documents: ' + error.message
    });
  }
});

// Query RAG documents
app.post('/api/admin/rag/query', authenticateToken, async (req, res) => {
  try {
    const { question, documentId, topK = 5 } = req.body;

    if (!question) {
      return res.status(400).json({ success: false, message: 'Question is required' });
    }

    if (!openaiClient) {
      return res.status(503).json({ 
        success: false, 
        message: 'OpenAI service is not configured. Check OPENAI_API_KEY in .env' 
      });
    }

    if (!pineconeClient) {
      return res.status(503).json({ 
        success: false, 
        message: 'Pinecone service is not configured. Check PINECONE_API_KEY in .env' 
      });
    }

    try {
      // Generate embedding for the question
      let queryVector;
      try {
        const queryEmbedding = await openaiClient.embeddings.create({
          model: 'text-embedding-3-small',
          input: question,
          dimensions: 1024,
        });
        queryVector = queryEmbedding.data[0].embedding;
      } catch (embedErr) {
        if (embedErr.status === 429 || embedErr.message?.includes('quota')) {
          return res.status(503).json({
            success: false,
            message: 'OpenAI quota exceeded. Please top up your OpenAI billing to use the AI query feature, or try again later.'
          });
        }
        throw embedErr;
      }

      // Query Pinecone
      const index = pineconeClient.index(process.env.PINECONE_INDEX);
      const pineconeFilter = await buildPineconeDocumentFilter(documentId);
      const queryResponse = await index.query({
        vector: queryVector,
        topK: topK,
        includeMetadata: true,
        filter: pineconeFilter,
      });

      const matches = queryResponse.matches || [];
      
      if (matches.length === 0) {
        return res.json({
          success: true,
          answer: 'I could not find any relevant information in the documents to answer your question. Please try uploading more documents or ask a different question.',
          sources: [],
          matches: []
        });
      }

      const sources = [];
      const context = matches
        .filter(m => m.metadata && m.metadata.text)
        .map(m => {
          sources.push(m.metadata.source || 'Unknown source');
          return m.metadata.text;
        })
        .join('\n\n');

      // Generate answer
      let answer;
      try {
        const completion = await openaiClient.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: `You are a helpful assistant that answers questions based on the provided context. 
              If the answer is not in the context, say "I don't have enough information to answer that question."
              Be concise and accurate.`
            },
            {
              role: 'user',
              content: `Context:\n${context}\n\nQuestion: ${question}`
            }
          ],
          temperature: 0.3,
          max_tokens: 500,
        });
        answer = completion.choices[0].message.content;
      } catch (chatErr) {
        if (chatErr.status === 429 || chatErr.message?.includes('quota')) {
          // Still return the relevant text chunks even if we can't generate an AI answer
          answer = `[OpenAI quota exceeded — showing raw matches]\n\n${context}`;
        } else {
          throw chatErr;
        }
      }

      // Log the query
      try {
        await supabase
          .from('rag_queries')
          .insert([{
            user_id: parseInt(req.user.id) || null,
            question: question,
            answer: answer,
            sources: sources,
            document_id: documentId || null,
            created_at: new Date().toISOString(),
          }]);
      } catch (logError) {
        console.error('Error logging query:', logError);
      }

      res.json({
        success: true,
        answer,
        sources: [...new Set(sources)],
        matches: matches.map(m => ({
          source: m.metadata?.source || 'Unknown',
          text: m.metadata?.text || '',
          score: m.score,
        })),
      });

    } catch (error) {
      console.error('RAG query error:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Failed to process query: ' + error.message 
      });
    }

  } catch (error) {
    console.error('RAG query error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to process query: ' + error.message 
    });
  }
});

// Get all RAG documents
app.get('/api/admin/rag/documents', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Check if table exists
    const { data: documents, error } = await supabase
      .from('rag_documents')
      .select('*')
      .order('created_at', { ascending: false });

    if (error && error.code === '42P01') {
      return res.json({ 
        success: true, 
        documents: [],
        message: 'Table not created yet. Please run the SQL migration.'
      });
    }

    if (error) {
      console.error('Error fetching RAG documents:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    res.json({ success: true, documents: documents || [] });
  } catch (error) {
    console.error('Fetch RAG documents error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch documents: ' + error.message 
    });
  }
});

// Delete RAG document
app.delete('/api/admin/rag/documents/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Get document
    const { data: doc, error: fetchError } = await supabase
      .from('rag_documents')
      .select('name')
      .eq('id', id)
      .single();

    if (fetchError) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    // Delete from Pinecone
    if (pineconeClient) {
      try {
        const index = pineconeClient.index(process.env.PINECONE_INDEX);
        await index.deleteMany({
          filter: {
            $or: [
              { documentId: { $eq: String(id) } },
              { source: { $eq: doc.name } }
            ]
          },
        });
      } catch (pineconeError) {
        console.error('Error deleting from Pinecone:', pineconeError);
      }
    }

    // Delete from database
    const { error } = await supabase
      .from('rag_documents')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Delete RAG document error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete document' });
  }
});

// Reindex RAG document
app.post('/api/admin/rag/reindex/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: doc, error: fetchError } = await supabase
      .from('rag_documents')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    await supabase
      .from('rag_documents')
      .update({ status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', id);

    // Simulate reindexing
    await supabase
      .from('rag_documents')
      .update({ status: 'processed', updated_at: new Date().toISOString() })
      .eq('id', id);

    res.json({ success: true, message: 'Reindexing started' });
  } catch (error) {
    console.error('Reindex error:', error);
    res.status(500).json({ success: false, message: 'Failed to reindex document' });
  }
});

// Get RAG statistics
app.get('/api/admin/rag/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: documents, error } = await supabase
      .from('rag_documents')
      .select('status, chunks, word_count, created_at');

    if (error && error.code === '42P01') {
      return res.json({
        success: true,
        stats: {
          total: 0,
          processed: 0,
          pending: 0,
          failed: 0,
          totalChunks: 0,
          totalWords: 0,
          avgChunksPerDoc: 0,
          totalQueries: 0,
          message: 'Table not created yet. Run SQL migration.'
        }
      });
    }

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    const stats = {
      total: documents.length,
      processed: documents.filter(d => d.status === 'processed').length,
      pending: documents.filter(d => d.status === 'pending').length,
      failed: documents.filter(d => d.status === 'failed').length,
      totalChunks: documents.reduce((sum, d) => sum + (d.chunks || 0), 0),
      totalWords: documents.reduce((sum, d) => sum + (d.word_count || 0), 0),
      avgChunksPerDoc: documents.length > 0 ? Math.round(documents.reduce((sum, d) => sum + (d.chunks || 0), 0) / documents.length) : 0,
    };

    try {
      const { count: queryCount, error: queryError } = await supabase
        .from('rag_queries')
        .select('*', { count: 'exact', head: true });

      if (!queryError) {
        stats.totalQueries = queryCount || 0;
      }
    } catch (queryError) {
      stats.totalQueries = 0;
    }

    res.json({ success: true, stats });
  } catch (error) {
    console.error('RAG stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to get stats' });
  }
});

// ============ REWARDS ENDPOINTS ============

// Get all rewards
app.get('/api/admin/rewards', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: rewards, error } = await supabase
      .from('rewards')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching rewards:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, rewards: rewards || [] });
  } catch (error) {
    console.error('Get rewards error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch rewards' });
  }
});

// Create reward
app.post('/api/admin/create-reward', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📝 Creating new reward:', req.body);
  
  try {
    const { name, description, points_required, stock_quantity, image_url, is_active } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Reward name is required' });
    }

    if (!points_required || points_required <= 0) {
      return res.status(400).json({ success: false, error: 'Points required must be greater than 0' });
    }

    const newReward = {
      name: name.trim(),
      description: description?.trim() || '',
      points_required: parseInt(points_required),
      stock_quantity: parseInt(stock_quantity) || 0,
      image_url: image_url || null,
      is_active: is_active !== false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('rewards')
      .insert([newReward])
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    console.log('✅ Reward created successfully:', data.id);
    res.json({ success: true, reward: data, message: 'Reward created successfully' });
  } catch (error) {
    console.error('Create reward error:', error);
    res.status(500).json({ success: false, error: 'Failed to create reward' });
  }
});

// Update reward
app.post('/api/admin/update-reward/:id', authenticateToken, requireAdmin, async (req, res) => {
  console.log('✏️ Updating reward:', req.params.id, req.body);
  
  try {
    const { id } = req.params;
    const { name, description, points_required, stock_quantity, image_url, is_active } = req.body;

    const { data: existingReward, error: fetchError } = await supabase
      .from('rewards')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError || !existingReward) {
      return res.status(404).json({ success: false, error: 'Reward not found' });
    }

    const updates = {
      name: name?.trim(),
      description: description?.trim() || '',
      points_required: parseInt(points_required),
      stock_quantity: parseInt(stock_quantity) || 0,
      image_url: image_url || null,
      is_active: is_active !== false,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('rewards')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Supabase update error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, reward: data, message: 'Reward updated successfully' });
  } catch (error) {
    console.error('Update reward error:', error);
    res.status(500).json({ success: false, error: 'Failed to update reward' });
  }
});

// Delete reward
app.delete('/api/admin/delete-reward/:id', authenticateToken, requireAdmin, async (req, res) => {
  console.log('🗑️ Deleting reward:', req.params.id);
  
  try {
    const { id } = req.params;

    const { data: existingReward, error: fetchError } = await supabase
      .from('rewards')
      .select('id, image_url')
      .eq('id', id)
      .single();

    if (fetchError || !existingReward) {
      return res.status(404).json({ success: false, error: 'Reward not found' });
    }

    if (existingReward.image_url) {
      try {
        const fileKey = existingReward.image_url.split('/').slice(-2).join('/');
        await deleteFromR2(fileKey);
        console.log('✅ Deleted image from R2');
      } catch (deleteError) {
        console.error('Error deleting image from R2:', deleteError);
      }
    }

    const { error } = await supabase
      .from('rewards')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Supabase delete error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, message: 'Reward deleted successfully' });
  } catch (error) {
    console.error('Delete reward error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete reward' });
  }
});

// Get learner rewards
app.get('/api/learner/rewards', authenticateToken, async (req, res) => {
  try {
    const { data: rewards, error } = await supabase
      .from('rewards')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching learner rewards:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, rewards: rewards || [] });
  } catch (error) {
    console.error('Get learner rewards error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch rewards' });
  }
});

// Redeem reward
app.post('/api/learner/redeem-reward', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { rewardId } = req.body;

    if (!rewardId) {
      return res.status(400).json({ error: 'Reward ID is required' });
    }

    const { data: reward, error: rewardError } = await supabase
      .from('rewards')
      .select('*')
      .eq('id', rewardId)
      .eq('is_active', true)
      .single();

    if (rewardError || !reward) {
      return res.status(404).json({ error: 'Reward not found' });
    }

    if (reward.stock_quantity !== undefined && reward.stock_quantity <= 0) {
      return res.status(400).json({ error: 'Reward is out of stock' });
    }

    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('current_points, lifetime_points')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (userData.current_points < reward.points_required) {
      return res.status(400).json({ error: 'Insufficient points' });
    }

    const newPoints = userData.current_points - reward.points_required;
    const newStock = reward.stock_quantity !== undefined ? reward.stock_quantity - 1 : null;

    const { error: updatePointsError } = await supabase
      .from('users')
      .update({
        current_points: newPoints,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updatePointsError) {
      console.error('Error updating points:', updatePointsError);
      return res.status(500).json({ error: 'Failed to process redemption' });
    }

    if (newStock !== null) {
      const { error: updateStockError } = await supabase
        .from('rewards')
        .update({
          stock_quantity: newStock,
          updated_at: new Date().toISOString()
        })
        .eq('id', rewardId);

      if (updateStockError) {
        console.error('Error updating stock:', updateStockError);
        await supabase
          .from('users')
          .update({
            current_points: userData.current_points,
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);
        return res.status(500).json({ error: 'Failed to process redemption' });
      }
    }

    // Generate voucher number: LE-XXXXXX (6 random alphanumeric chars)
    const voucherChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let voucher = 'LE-';
    for (let i = 0; i < 6; i++) {
      voucher += voucherChars.charAt(Math.floor(Math.random() * voucherChars.length));
    }

    // Insert redemption record — simplified, no reward_id to avoid UUID issues
    console.log('💾 Saving redemption: user_id=', userId, 'type=', typeof userId, 'voucher=', voucher, 'reward=', reward.name);
    
    const { error: insertErr } = await supabase
      .from('redemptions')
      .insert({
        user_id: userId,
        points_spent: reward.points_required,
        reward_name: reward.name,
        voucher_number: voucher,
        redeemed_at: new Date().toISOString(),
        status: 'completed',
        collected: false
      });

    if (insertErr) {
      console.error('❌ REDEMPTION INSERT ERROR:', insertErr.message, insertErr.code, insertErr.details);
      // Points already deducted — return success but with warning
      return res.json({
        success: true,
        message: `Redeemed! Save error: ${insertErr.message}`,
        points_remaining: newPoints,
        voucher_number: voucher,
        reward_name: reward.name,
        _debug: { error: insertErr.message, user_id: userId, user_id_type: typeof userId }
      });
    }
    
    console.log('✅ Redemption saved! user_id=', userId, 'voucher=', voucher);

    return res.json({
      success: true,
      message: 'Reward redeemed successfully!',
      points_remaining: newPoints,
      voucher_number: voucher,
      reward_name: reward.name
    });
  } catch (error) {
    console.error('Redeem reward error:', error);
    res.status(500).json({ error: 'Failed to redeem reward' });
  }
});

// ============ REDEMPTION HISTORY ============

// TEST endpoint: verify redemptions table works
app.get('/api/test/redemptions', async (req, res) => {
  try {
    // Step 1: Try inserting
    const { error: insertErr } = await supabase
      .from('redemptions')
      .insert({
        user_id: 1,
        points_spent: 0,
        reward_name: 'TEST',
        voucher_number: 'TEST-' + Date.now(),
        redeemed_at: new Date().toISOString(),
        status: 'completed',
        collected: false
      });

    if (insertErr) {
      return res.json({ 
        success: false, 
        step: 'insert', 
        error: insertErr.message,
        code: insertErr.code,
        details: insertErr.details,
        hint: insertErr.hint
      });
    }

    // Step 2: Read back
    const { data: rows, error: readErr } = await supabase
      .from('redemptions')
      .select('*')
      .order('redeemed_at', { ascending: false })
      .limit(5);

    if (readErr) {
      return res.json({ success: false, step: 'read', error: readErr.message });
    }

    return res.json({ 
      success: true, 
      message: 'INSERT + READ both work!',
      total_rows: rows.length,
      latest: rows[0] || null
    });
  } catch (error) {
    return res.json({ success: false, step: 'catch', error: error.message });
  }
});

// GET learner's own redemption history
app.get('/api/learner/redemptions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const numericUserId = parseInt(userId);

    if (isNaN(numericUserId)) {
      return res.status(400).json({ success: false, error: 'Invalid user ID', redemptions: [] });
    }

    const { data: redemptions, error } = await supabase
      .from('redemptions')
      .select('*')
      .eq('user_id', numericUserId)
      .order('redeemed_at', { ascending: false });

    if (error) {
      console.error('Fetch redemptions error:', error);
      return res.status(400).json({ success: false, error: error.message, redemptions: [] });
    }

    return res.json({ success: true, redemptions: redemptions || [] });
  } catch (error) {
    console.error('Get learner redemptions error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch redemptions', redemptions: [] });
  }
});

// GET all redemptions (admin — includes learner name)
app.get('/api/admin/redemptions', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Fetch redemptions without join (foreign key may not exist)
    const { data: redemptions, error } = await supabase
      .from('redemptions')
      .select('*')
      .order('redeemed_at', { ascending: false });

    if (error) {
      console.error('Admin fetch redemptions error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    // Get unique user IDs and fetch their info separately
    const userIds = [...new Set((redemptions || []).map(r => r.user_id).filter(Boolean))];
    let usersMap = {};

    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, username, full_name, class_level')
        .in('id', userIds);
      
      (users || []).forEach(u => { usersMap[u.id] = u; });
    }

    const formatted = (redemptions || []).map(r => {
      const user = usersMap[r.user_id] || {};
      return {
        id: r.id,
        voucher_number: r.voucher_number,
        reward_name: r.reward_name,
        points_spent: r.points_spent,
        redeemed_at: r.redeemed_at,
        status: r.status,
        collected: r.collected || false,
        collected_at: r.collected_at,
        user_id: r.user_id,
        learner_name: user.full_name || user.username || 'Unknown',
        learner_class: user.class_level || '',
      };
    });

    // Calculate totals
    const totalPointsSpent = formatted.reduce((sum, r) => sum + (r.points_spent || 0), 0);
    const totalRefunded = formatted.filter(r => r.status === 'refunded').reduce((sum, r) => sum + (r.points_spent || 0), 0);
    const totalCollected = formatted.filter(r => r.collected).length;
    const totalPending = formatted.filter(r => !r.collected && r.status !== 'refunded').length;

    res.json({ 
      success: true, 
      redemptions: formatted,
      summary: {
        total_redemptions: formatted.length,
        total_points_spent: totalPointsSpent,
        total_refunded: totalRefunded,
        total_collected: totalCollected,
        total_pending: totalPending,
      }
    });
  } catch (error) {
    console.error('Admin get redemptions error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch redemptions' });
  }
});

// PUT mark redemption as collected (admin)
app.put('/api/admin/redemptions/:id/collected', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { collected } = req.body;

    const { data, error } = await supabase
      .from('redemptions')
      .update({
        collected: collected,
        collected_at: collected ? new Date().toISOString() : null
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, redemption: data });
  } catch (error) {
    console.error('Update collection status error:', error);
    res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

// POST refund a redemption (admin — gives points back to learner and deletes the redemption)
app.post('/api/admin/redemptions/:id/refund', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the redemption
    const { data: redemption, error: fetchErr } = await supabase
      .from('redemptions')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !redemption) {
      return res.status(404).json({ success: false, error: 'Redemption not found' });
    }

    if (redemption.status === 'refunded') {
      return res.status(400).json({ success: false, error: 'Already refunded' });
    }

    if (redemption.collected) {
      return res.status(400).json({ success: false, error: 'Cannot refund a collected item' });
    }

    const userId = redemption.user_id;
    const pointsToReturn = redemption.points_spent || 0;

    // Give points back to learner
    if (userId && pointsToReturn > 0) {
      const { data: userData } = await supabase
        .from('users')
        .select('current_points')
        .eq('id', userId)
        .single();

      if (userData) {
        await supabase
          .from('users')
          .update({ 
            current_points: (userData.current_points || 0) + pointsToReturn 
          })
          .eq('id', userId);
      }
    }

    // Restore stock on the reward if applicable
    if (redemption.reward_id) {
      const { data: reward } = await supabase
        .from('rewards')
        .select('stock_quantity')
        .eq('id', redemption.reward_id)
        .single();

      if (reward && reward.stock_quantity !== null) {
        await supabase
          .from('rewards')
          .update({ stock_quantity: reward.stock_quantity + 1 })
          .eq('id', redemption.reward_id);
      }
    }

    // Mark as refunded and revoke voucher
    await supabase
      .from('redemptions')
      .update({ 
        status: 'refunded',
        refunded_at: new Date().toISOString(),
        voucher_number: null,
        collected: false,
        collected_at: null
      })
      .eq('id', id);

    res.json({
      success: true,
      message: `Refunded ${pointsToReturn} points back to the learner.`,
      points_returned: pointsToReturn
    });
  } catch (error) {
    console.error('Refund redemption error:', error);
    res.status(500).json({ success: false, error: 'Failed to process refund' });
  }
});

// POST refund ALL pending redemptions for a learner (admin)
app.post('/api/admin/redemptions/refund-all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;

    // Get all non-refunded redemptions (optionally filtered by user)
    let query = supabase
      .from('redemptions')
      .select('*')
      .neq('status', 'refunded');
    
    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: redemptions, error: fetchErr } = await query;

    if (fetchErr) {
      return res.status(400).json({ success: false, error: fetchErr.message });
    }

    if (!redemptions || redemptions.length === 0) {
      return res.status(400).json({ success: false, error: 'No redemptions to refund' });
    }

    let totalRefunded = 0;
    let refundCount = 0;

    // Group by user_id to batch point returns
    const byUser = {};
    for (const r of redemptions) {
      if (!byUser[r.user_id]) byUser[r.user_id] = [];
      byUser[r.user_id].push(r);
    }

    // Return points to each user
    for (const [uid, userRedemptions] of Object.entries(byUser)) {
      const pointsToReturn = userRedemptions.reduce((sum, r) => sum + (r.points_spent || 0), 0);
      
      if (pointsToReturn > 0) {
        const { data: userData } = await supabase
          .from('users')
          .select('current_points')
          .eq('id', uid)
          .single();

        if (userData) {
          await supabase
            .from('users')
            .update({ current_points: (userData.current_points || 0) + pointsToReturn })
            .eq('id', uid);
        }
      }

      totalRefunded += pointsToReturn;
      refundCount += userRedemptions.length;
    }

    // Mark all as refunded
    const ids = redemptions.map(r => r.id);
    await supabase
      .from('redemptions')
      .update({ status: 'refunded' })
      .in('id', ids);

    res.json({
      success: true,
      message: `Refunded ${refundCount} redemptions. ${totalRefunded} total points returned.`,
      refund_count: refundCount,
      total_points_returned: totalRefunded
    });
  } catch (error) {
    console.error('Refund all error:', error);
    res.status(500).json({ success: false, error: 'Failed to process refund' });
  }
});

// ============ LEARNER REFUND REQUESTS ============

// Learner requests refund
app.post('/api/learner/request-refund', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { redemptionId } = req.body;

    // Check if redemption exists and belongs to learner
    const { data: redemption, error: fetchErr } = await supabase
      .from('redemptions')
      .select('*')
      .eq('id', redemptionId)
      .eq('user_id', userId)
      .single();

    if (fetchErr || !redemption) {
      return res.status(404).json({ success: false, error: 'Redemption not found' });
    }

    // Check if already refunded
    if (redemption.status === 'refunded' || redemption.status === 'deleted') {
      return res.status(400).json({ success: false, error: 'This voucher has already been refunded' });
    }

    // Check if already requested
    if (redemption.status === 'pending_refund') {
      return res.status(400).json({ success: false, error: 'Refund already requested' });
    }

    // Update status to pending_refund
    const { error: updateErr } = await supabase
      .from('redemptions')
      .update({
        status: 'pending_refund',
        refund_requested_at: new Date().toISOString()
      })
      .eq('id', redemptionId);

    if (updateErr) {
      console.error('Update error:', updateErr);
      return res.status(500).json({ success: false, error: 'Failed to request refund' });
    }

    res.json({ 
      success: true, 
      message: 'Refund request submitted successfully' 
    });
  } catch (error) {
    console.error('Request refund error:', error);
    res.status(500).json({ success: false, error: 'Failed to request refund' });
  }
});

// Admin get pending refunds
app.get('/api/admin/pending-refunds', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: redemptions, error } = await supabase
      .from('redemptions')
      .select('*')
      .eq('status', 'pending_refund')
      .order('refund_requested_at', { ascending: true });

    if (error) {
      console.error('Fetch pending refunds error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    // Get learner names
    const userIds = [...new Set((redemptions || []).map(r => r.user_id).filter(Boolean))];
    let usersMap = {};

    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, username, full_name, class_level')
        .in('id', userIds);
      
      (users || []).forEach(u => { usersMap[u.id] = u; });
    }

    const formatted = (redemptions || []).map(r => ({
      ...r,
      learner_name: usersMap[r.user_id]?.full_name || usersMap[r.user_id]?.username || 'Unknown',
      learner_class: usersMap[r.user_id]?.class_level || '',
    }));

    res.json({ success: true, refunds: formatted });
  } catch (error) {
    console.error('Get pending refunds error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch pending refunds' });
  }
});

// Admin approve refund - DELETE voucher and return points
app.post('/api/admin/approve-refund/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the redemption
    const { data: redemption, error: fetchErr } = await supabase
      .from('redemptions')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !redemption) {
      return res.status(404).json({ success: false, error: 'Redemption not found' });
    }

    if (redemption.status !== 'pending_refund') {
      return res.status(400).json({ success: false, error: 'This redemption is not pending refund' });
    }

    const userId = redemption.user_id;
    const pointsToReturn = redemption.points_spent || 0;

    // Return points to learner
    if (userId && pointsToReturn > 0) {
      const { data: userData } = await supabase
        .from('users')
        .select('current_points')
        .eq('id', userId)
        .single();

      if (userData) {
        await supabase
          .from('users')
          .update({ 
            current_points: (userData.current_points || 0) + pointsToReturn 
          })
          .eq('id', userId);
      }
    }

    // Restore stock on the reward if applicable
    if (redemption.reward_id) {
      const { data: reward } = await supabase
        .from('rewards')
        .select('stock_quantity')
        .eq('id', redemption.reward_id)
        .single();

      if (reward && reward.stock_quantity !== null) {
        await supabase
          .from('rewards')
          .update({ stock_quantity: reward.stock_quantity + 1 })
          .eq('id', redemption.reward_id);
      }
    }

    // DELETE the redemption (mark as deleted with revoked voucher)
    await supabase
      .from('redemptions')
      .update({ 
        status: 'deleted',
        deleted_at: new Date().toISOString(),
        refunded_at: new Date().toISOString(),
        voucher_number: null,
        collected: false,
        collected_at: null
      })
      .eq('id', id);

    res.json({
      success: true,
      message: `Refund approved! ${pointsToReturn} points returned to learner. Voucher deleted.`,
      points_returned: pointsToReturn
    });
  } catch (error) {
    console.error('Approve refund error:', error);
    res.status(500).json({ success: false, error: 'Failed to approve refund' });
  }
});

// Admin deny refund request
app.post('/api/admin/deny-refund/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: redemption, error: fetchErr } = await supabase
      .from('redemptions')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !redemption) {
      return res.status(404).json({ success: false, error: 'Redemption not found' });
    }

    if (redemption.status !== 'pending_refund') {
      return res.status(400).json({ success: false, error: 'This redemption is not pending refund' });
    }

    // Set back to active status
    await supabase
      .from('redemptions')
      .update({ 
        status: 'completed',
        refund_requested_at: null
      })
      .eq('id', id);

    res.json({
      success: true,
      message: 'Refund request denied. Voucher remains active.'
    });
  } catch (error) {
    console.error('Deny refund error:', error);
    res.status(500).json({ success: false, error: 'Failed to deny refund' });
  }
});

// ============ LEADERBOARD ============
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { district } = req.query;

    let query = supabase
      .from('users')
      .select('id, username, full_name, class_level, district, current_points, lifetime_points, role')
      .eq('role', 'learner')
      .order('lifetime_points', { ascending: false });

    if (district && district !== 'all') {
      query = query.eq('district', district);
    }

    const { data: learners, error } = await query;

    if (error) {
      console.error('Error fetching leaderboard:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    const leaderboard = (learners || []).map((learner, index) => ({
      ...learner,
      rank: index + 1
    }));

    res.json({ success: true, leaderboard, total: leaderboard.length });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

// GET all Malawi districts
app.get('/api/districts', async (req, res) => {
  const districts = [
    'Balaka', 'Blantyre', 'Chikwawa', 'Chiradzulu', 'Chitipa',
    'Dedza', 'Dowa', 'Karonga', 'Kasungu', 'Likoma',
    'Lilongwe', 'Machinga', 'Mangochi', 'Mchinji', 'Mulanje',
    'Mwanza', 'Mzimba', 'Neno', 'Nkhata Bay', 'Nkhotakota',
    'Nsanje', 'Ntcheu', 'Ntchisi', 'Phalombe', 'Rumphi',
    'Salima', 'Thyolo', 'Zomba'
  ];
  res.json({ success: true, districts });
});

const DISTRICT_QUIZ_CATEGORIES = [
  { id: 'capitals-major-towns', label: 'Capitals and Major Towns' },
  { id: 'borders-neighbors', label: 'Borders and Neighbors' },
  { id: 'physical-features', label: 'Physical Features' },
  { id: 'parks-wildlife', label: 'National Parks and Wildlife' },
  { id: 'economic-activities', label: 'Economic Activities' },
  { id: 'transport-border-posts', label: 'Transport and Border Posts' },
  { id: 'history-culture', label: 'History and Cultural Landmarks' },
  { id: 'region-classification', label: 'Region Classification' },
];

const DISTRICT_QUIZ_CATEGORY_IDS = new Set(DISTRICT_QUIZ_CATEGORIES.map(c => c.id));

const normalizeDistrictCategory = (value) => {
  const normalized = String(value || 'all').trim().toLowerCase();
  if (normalized === 'all') return 'all';
  if (DISTRICT_QUIZ_CATEGORY_IDS.has(normalized)) return normalized;
  return null;
};

// GET district quiz categories
app.get('/api/districts/categories', async (req, res) => {
  res.json({
    success: true,
    categories: [{ id: 'all', label: 'Mixed Challenge' }, ...DISTRICT_QUIZ_CATEGORIES],
  });
});

// GET Malawi Districts quiz questions (answers are always districts)
app.get('/api/districts/quiz', authenticateToken, async (req, res) => {
  try {
    const { count = 10, category = 'all' } = req.query;
    const requestedCategory = normalizeDistrictCategory(category);

    if (!requestedCategory) {
      return res.status(400).json({
        success: false,
        error: 'Invalid district category',
        categories: [{ id: 'all', label: 'Mixed Challenge' }, ...DISTRICT_QUIZ_CATEGORIES],
      });
    }

    // Fetch questions from database
    let { data: dbQuestions, error } = await supabase
      .from('district_questions')
      .select('id, question, correct_answer, image_url, category')
      .eq('is_active', true);

    // Backward compatibility: older schema may not have the category column yet.
    if (error && String(error.message || '').toLowerCase().includes('category')) {
      const fallbackQuery = await supabase
        .from('district_questions')
        .select('id, question, correct_answer, image_url')
        .eq('is_active', true);
      dbQuestions = fallbackQuery.data;
      error = fallbackQuery.error;
    }

    let districtQuestions = [];

    if (!error && dbQuestions && dbQuestions.length > 0) {
      districtQuestions = dbQuestions.map(q => ({
        question: String(q.question || '').toLowerCase(),
        correctAnswer: q.correct_answer,
        questionImage: q.image_url || null,
        category: q.category || null,
      }));
    } else {
      // Fallback hardcoded questions if table doesn't exist yet
      districtQuestions = [
        { question: 'which district is the capital city of malawi located in?', correctAnswer: 'Lilongwe', category: 'capitals-major-towns' },
        { question: 'which district is home to mount mulanje, the highest peak in malawi?', correctAnswer: 'Mulanje', category: 'physical-features' },
        { question: 'which district is the commercial capital of malawi?', correctAnswer: 'Blantyre', category: 'capitals-major-towns' },
        { question: 'which district contains the southern tip of lake malawi?', correctAnswer: 'Mangochi', category: 'physical-features' },
        { question: 'which district is known for liwonde national park?', correctAnswer: 'Machinga', category: 'parks-wildlife' },
        { question: 'which district is in the far north of malawi bordering tanzania?', correctAnswer: 'Chitipa', category: 'borders-neighbors' },
        { question: 'which district is home to zomba plateau?', correctAnswer: 'Zomba', category: 'physical-features' },
        { question: 'which district is known for kasungu national park?', correctAnswer: 'Kasungu', category: 'parks-wildlife' },
        { question: 'which district is famous for tea estates in malawi?', correctAnswer: 'Thyolo', category: 'economic-activities' },
        { question: 'which district was the old capital of malawi before lilongwe?', correctAnswer: 'Zomba', category: 'history-culture' },
      ];
    }

    const effectiveCategory = requestedCategory === 'all'
      ? 'all'
      : (districtQuestions.some(q => q.category === requestedCategory) ? requestedCategory : 'all');

    const categoryPool = effectiveCategory === 'all'
      ? districtQuestions
      : districtQuestions.filter(q => q.category === effectiveCategory);

    const allDistricts = [
      'Balaka', 'Blantyre', 'Chikwawa', 'Chiradzulu', 'Chitipa',
      'Dedza', 'Dowa', 'Karonga', 'Kasungu', 'Likoma',
      'Lilongwe', 'Machinga', 'Mangochi', 'Mchinji', 'Mulanje',
      'Mwanza', 'Mzimba', 'Neno', 'Nkhata Bay', 'Nkhotakota',
      'Nsanje', 'Ntcheu', 'Ntchisi', 'Phalombe', 'Rumphi',
      'Salima', 'Thyolo', 'Zomba'
    ];

    // Shuffle and pick requested count
    const shuffled = [...categoryPool].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(Number(count), categoryPool.length));

    // Generate 4 options for each question
    const questions = selected.map((q, idx) => {
      const wrongOptions = allDistricts
        .filter(d => d !== q.correctAnswer)
        .sort(() => Math.random() - 0.5)
        .slice(0, 3);

      const options = [q.correctAnswer, ...wrongOptions].sort(() => Math.random() - 0.5);

      return {
        id: `district-${idx}-${Date.now()}`,
        question: String(q.question || '').toLowerCase(),
        options,
        correctAnswer: q.correctAnswer,
        category: q.category || null,
        layout: q.questionImage ? 'image-left' : 'text-first',
        questionImage: q.questionImage || null,
      };
    });

    res.json({
      success: true,
      quiz: {
        id: 'malawi-districts',
        title: 'Malawi Districts Challenge',
        topic: 'social-studies',
        class_level: null,
        quiz_level: 1,
        district_category: effectiveCategory,
        available_categories: [{ id: 'all', label: 'Mixed Challenge' }, ...DISTRICT_QUIZ_CATEGORIES],
        questions,
        total_questions_available: categoryPool.length,
      }
    });
  } catch (error) {
    console.error('Districts quiz error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate districts quiz' });
  }
});

// ── Admin CRUD for District Questions ──

// GET all district questions (admin)
app.get('/api/admin/district-questions', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: questions, error } = await supabase
      .from('district_questions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ success: false, error: error.message });

    res.json({ success: true, questions: questions || [] });
  } catch (error) {
    console.error('Fetch district questions error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch questions' });
  }
});

// POST add new district question (admin) — supports image upload
app.post('/api/admin/district-questions', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { question, correct_answer, category } = req.body;
    const normalizedCategory = normalizeDistrictCategory(category);

    if (!question || !correct_answer) {
      return res.status(400).json({ success: false, error: 'Question and correct answer are required' });
    }

    if (!normalizedCategory || normalizedCategory === 'all') {
      return res.status(400).json({
        success: false,
        error: 'A valid district category is required',
      });
    }

    let imageUrl = null;
    if (req.file) {
      const fileName = `districts/${Date.now()}-${req.file.originalname}`;
      const uploadResult = await uploadToR2(req.file.buffer, fileName, req.file.mimetype);
      if (uploadResult.success) {
        imageUrl = uploadResult.url;
      }
    }

    const { data, error } = await supabase
      .from('district_questions')
      .insert({
        question: question.trim().toLowerCase(),
        correct_answer: correct_answer.trim(),
        category: normalizedCategory,
        image_url: imageUrl,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, error: error.message });

    res.json({ success: true, question: data, message: 'Question added' });
  } catch (error) {
    console.error('Add district question error:', error);
    res.status(500).json({ success: false, error: 'Failed to add question' });
  }
});

// PUT update district question (admin) — supports image upload
app.put('/api/admin/district-questions/:id', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { question, correct_answer, category, is_active, remove_image } = req.body;

    const updateData = { updated_at: new Date().toISOString() };
    if (question !== undefined) updateData.question = question.trim().toLowerCase();
    if (correct_answer !== undefined) updateData.correct_answer = correct_answer.trim();
    if (category !== undefined) {
      const normalizedCategory = normalizeDistrictCategory(category);
      if (!normalizedCategory || normalizedCategory === 'all') {
        return res.status(400).json({ success: false, error: 'Invalid district category' });
      }
      updateData.category = normalizedCategory;
    }
    if (is_active !== undefined) updateData.is_active = is_active === 'true' || is_active === true;

    // Handle image
    if (remove_image === 'true') {
      updateData.image_url = null;
    }
    if (req.file) {
      const fileName = `districts/${Date.now()}-${req.file.originalname}`;
      const uploadResult = await uploadToR2(req.file.buffer, fileName, req.file.mimetype);
      if (uploadResult.success) {
        updateData.image_url = uploadResult.url;
      }
    }

    const { data, error } = await supabase
      .from('district_questions')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, error: error.message });

    res.json({ success: true, question: data, message: 'Question updated' });
  } catch (error) {
    console.error('Update district question error:', error);
    res.status(500).json({ success: false, error: 'Failed to update question' });
  }
});

// DELETE district question (admin)
app.delete('/api/admin/district-questions/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('district_questions')
      .delete()
      .eq('id', id);

    if (error) return res.status(400).json({ success: false, error: error.message });

    res.json({ success: true, message: 'Question deleted' });
  } catch (error) {
    console.error('Delete district question error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete question' });
  }
});

// ============ RANDOMIZATION HELPERS ============
const shuffleArray = (array) => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const randomizeQuizQuestions = (questions) => {
  if (!questions || !Array.isArray(questions)) return [];
  
  let parsedQuestions = questions;
  if (typeof questions === 'string') {
    parsedQuestions = JSON.parse(questions);
  }
  
  const shuffledQuestions = shuffleArray([...parsedQuestions]);
  
  const randomizedQuestions = shuffledQuestions.map((question) => {
    const optionsWithMeta = (question.options || []).map((option, optIdx) => ({
      text: option,
      originalIndex: optIdx,
      isCorrect: option === question.correctAnswer
    }));
    
    const shuffledOptions = shuffleArray(optionsWithMeta);
    const newCorrectAnswer = shuffledOptions.find(opt => opt.isCorrect)?.text || question.correctAnswer;
    
    return {
      ...question,
      options: shuffledOptions.map(opt => opt.text),
      correctAnswer: newCorrectAnswer
    };
  });
  
  return randomizedQuestions;
};

const selectRandomQuestions = (questionBank, numberOfQuestions = 20) => {
  if (!questionBank || !Array.isArray(questionBank)) return [];
  
  let questions = questionBank;
  if (typeof questionBank === 'string') {
    questions = JSON.parse(questionBank);
  }
  
  if (questions.length <= numberOfQuestions) {
    return shuffleArray(questions);
  }
  
  const shuffled = shuffleArray([...questions]);
  return shuffled.slice(0, numberOfQuestions);
};

// ============ LEVEL HELPERS ============
const ALL_LEVELS = [
  'standard-1', 'standard-2', 'standard-3', 'standard-4',
  'standard-5', 'standard-6', 'standard-7', 'standard-8',
  'form-1', 'form-2', 'form-3', 'form-4'
];

// ============ SMART CORRECT ANSWER DETECTION ============
function detectCorrectAnswer(question, options, originalText = '') {
  if (!options || options.length === 0) return '';
  
  const cleanOptions = options.map(opt => opt.replace(/[✓*]/g, '').trim());
  
  if (originalText) {
    for (let i = 0; i < options.length; i++) {
      const originalOpt = options[i];
      if (originalOpt.includes('✓') || 
          originalOpt.includes('*') || 
          originalOpt.includes('(correct)') ||
          originalOpt.toLowerCase().includes('correct answer')) {
        return cleanOptions[i];
      }
    }
  }
  
  for (let i = 0; i < cleanOptions.length; i++) {
    const opt = cleanOptions[i];
    if (opt === opt.toUpperCase() && opt.length > 2 && !opt.includes(' ')) {
      return opt;
    }
  }
  
  const questionLower = question.toLowerCase();
  const keywordMatches = [];
  
  for (let i = 0; i < cleanOptions.length; i++) {
    const optLower = cleanOptions[i].toLowerCase();
    if (optLower.length > 3 && questionLower.includes(optLower)) {
      keywordMatches.push({ index: i, score: optLower.length });
    }
  }
  
  if (keywordMatches.length > 0) {
    keywordMatches.sort((a, b) => b.score - a.score);
    return cleanOptions[keywordMatches[0].index];
  }
  
  const longestIndex = cleanOptions.reduce((maxIdx, opt, idx, arr) => 
    opt.length > arr[maxIdx].length ? idx : maxIdx, 0);
  
  const avgLength = cleanOptions.reduce((sum, opt) => sum + opt.length, 0) / cleanOptions.length;
  if (cleanOptions[longestIndex].length > avgLength * 1.3) {
    return cleanOptions[longestIndex];
  }
  
  for (let i = 0; i < cleanOptions.length; i++) {
    const optLower = cleanOptions[i].toLowerCase();
    if (optLower.includes('all of the above') || optLower.includes('all the above')) {
      return cleanOptions[i];
    }
  }
  
  return cleanOptions[0];
}

function ensureFourOptions(options) {
  const clean = options.filter(o => o && o.trim() !== '');
  while (clean.length < 4) clean.push('');
  return clean.slice(0, 4);
}

function parseCSVRow(row) {
  const result = [];
  let inQuotes = false;
  let currentField = '';
  
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(currentField.trim());
      currentField = '';
    } else {
      currentField += char;
    }
  }
  result.push(currentField.trim());
  
  return result;
}

function extractQuestionsFromText(text) {
  const questions = [];
  const lines = text.split('\n');
  
  let currentQuestion = null;
  let currentOptions = [];
  let currentCorrectAnswer = null;
  let currentRawOptions = [];
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.length < 3) continue;
    
    const isQuestionLine = (
      line.includes('?') || 
      /^\d+[\.\)]/.test(line) ||
      /^Q\d+[\.\):]/i.test(line) ||
      /^Question\s*\d+/i.test(line)
    );
    
    if ((isQuestionLine || (line.endsWith('?') && line.length < 200)) && !line.match(/^[A-D][\.\)]/)) {
      if (currentQuestion && currentOptions.length >= 2) {
        if (!currentCorrectAnswer) {
          currentCorrectAnswer = detectCorrectAnswer(currentQuestion, currentRawOptions, currentRawOptions.join(' '));
        }
        
        questions.push({
          id: `q-${Date.now()}-${questions.length}`,
          question: currentQuestion.toLowerCase(),
          options: ensureFourOptions(currentOptions),
          correctAnswer: currentCorrectAnswer,
          layout: 'text-first'
        });
      }
      
      currentQuestion = line
        .replace(/^\d+[\.\)]\s*/, '')
        .replace(/^Q\d+[\.\):]\s*/i, '')
        .replace(/^Question\s*\d+[\.\):]\s*/i, '')
        .trim();
      currentOptions = [];
      currentRawOptions = [];
      currentCorrectAnswer = null;
    }
    else if (/^[A-D][\.\)]/.test(line) && currentQuestion) {
      let option = line.replace(/^[A-D][\.\)]\s*/, '').trim();
      const originalOption = option;
      
      const isCorrect = (
        option.includes('✓') || 
        option.includes('*') || 
        option.includes('(correct)') ||
        option.toLowerCase().includes('correct answer') ||
        option.toLowerCase().includes('**') ||
        line.includes('✓') ||
        line.includes('*')
      );
      
      option = option
        .replace(/[✓*]/g, '')
        .replace(/\(\s*correct\s*\)/i, '')
        .replace(/\s+correct\s*$/i, '')
        .replace(/\*\*/g, '')
        .trim();
      
      if (option) {
        currentOptions.push(option);
        currentRawOptions.push(originalOption);
        if (isCorrect) {
          currentCorrectAnswer = option;
        }
      }
    }
    else if (line.match(/^answer\s*:/i) && currentQuestion) {
      const answerMatch = line.match(/^answer\s*:\s*(.+)/i);
      if (answerMatch) {
        let answer = answerMatch[1].trim();
        answer = answer.replace(/[✓*]/g, '').replace(/\(correct\)/i, '').trim();
        
        for (let opt of currentOptions) {
          if (opt.toLowerCase() === answer.toLowerCase() ||
              opt.toLowerCase().includes(answer.toLowerCase()) ||
              answer.toLowerCase().includes(opt.toLowerCase())) {
            currentCorrectAnswer = opt;
            break;
          }
        }
        
        const letterMatch = answer.match(/^([A-D])/i);
        if (letterMatch && !currentCorrectAnswer) {
          const letterIndex = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
          if (currentOptions[letterIndex]) {
            currentCorrectAnswer = currentOptions[letterIndex];
          }
        }
        
        if (!currentCorrectAnswer && currentOptions.length > 0) {
          currentCorrectAnswer = currentOptions[0];
        }
      }
    }
  }
  
  if (currentQuestion && currentOptions.length >= 2) {
    if (!currentCorrectAnswer) {
      currentCorrectAnswer = detectCorrectAnswer(currentQuestion, currentRawOptions, currentRawOptions.join(' '));
    }
    
    questions.push({
      id: `q-${Date.now()}-${questions.length}`,
      question: currentQuestion.toLowerCase(),
      options: ensureFourOptions(currentOptions),
      correctAnswer: currentCorrectAnswer,
      layout: 'text-first'
    });
  }
  
  return questions;
}

// ============ HANGMAN ROUTES ============

// Get all words (admin)
app.get('/api/admin/hangman/words', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: words, error } = await supabase
      .from('words')
      .select('*')
      .order('category', { ascending: true })
      .order('word', { ascending: true });

    if (error) throw error;
    res.json({ success: true, words });
  } catch (error) {
    console.error('Error fetching words:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words' });
  }
});

// Add word (admin)
app.post('/api/admin/hangman/words', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { word, category, hint, difficulty, points } = req.body;
    
    if (!word || !category) {
      return res.status(400).json({ success: false, message: 'Word and category are required' });
    }

    const { data: existingWord, error: checkError } = await supabase
      .from('words')
      .select('id')
      .eq('word', word.toUpperCase())
      .eq('category', category)
      .maybeSingle();

    if (existingWord) {
      return res.status(400).json({ success: false, message: 'This word already exists in this category' });
    }

    let imageUrl = null;
    let imagePath = null;

    if (req.file) {
      const fileName = `hangman/${Date.now()}-${req.file.originalname}`;
      const uploadResult = await uploadToR2(req.file.buffer, fileName, req.file.mimetype);
      if (uploadResult.success) {
        imageUrl = uploadResult.url;
        imagePath = fileName;
      } else {
        return res.status(500).json({ success: false, message: 'Failed to upload image' });
      }
    }

    const wordData = {
      word: word.toUpperCase(),
      category,
      hint: hint || '',
      difficulty: difficulty || 'medium',
      points: parseInt(points) || 10,
      image_url: imageUrl,
      image_path: imagePath,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: newWord, error } = await supabase
      .from('words')
      .insert([wordData])
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: 'Word added successfully', word: newWord });
  } catch (error) {
    console.error('Error adding word:', error);
    res.status(500).json({ success: false, message: 'Failed to add word: ' + error.message });
  }
});

// Update word (admin)
app.put('/api/admin/hangman/words/:id', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { word, category, hint, difficulty, points, removeImage, is_active } = req.body;

    const { data: existingWord, error: fetchError } = await supabase
      .from('words')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !existingWord) {
      return res.status(404).json({ success: false, message: 'Word not found' });
    }

    let imageUrl = existingWord.image_url;
    let imagePath = existingWord.image_path;

    if (removeImage === 'true' || removeImage === true) {
      if (existingWord.image_path) {
        await deleteFromR2(existingWord.image_path);
      }
      imageUrl = null;
      imagePath = null;
    }

    if (req.file) {
      if (existingWord.image_path) {
        await deleteFromR2(existingWord.image_path);
      }
      const fileName = `hangman/${Date.now()}-${req.file.originalname}`;
      const uploadResult = await uploadToR2(req.file.buffer, fileName, req.file.mimetype);
      if (uploadResult.success) {
        imageUrl = uploadResult.url;
        imagePath = fileName;
      } else {
        return res.status(500).json({ success: false, message: 'Failed to upload image' });
      }
    }

    const wordData = {
      word: word ? word.toUpperCase() : existingWord.word,
      category: category || existingWord.category,
      hint: hint !== undefined ? hint : existingWord.hint,
      difficulty: difficulty || existingWord.difficulty,
      points: points !== undefined ? parseInt(points) : existingWord.points,
      image_url: imageUrl,
      image_path: imagePath,
      updated_at: new Date().toISOString()
    };

    if (is_active !== undefined) {
      wordData.is_active = is_active;
    }

    const { data: updatedWord, error } = await supabase
      .from('words')
      .update(wordData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: 'Word updated successfully', word: updatedWord });
  } catch (error) {
    console.error('Error updating word:', error);
    res.status(500).json({ success: false, message: 'Failed to update word: ' + error.message });
  }
});

// Delete word (admin)
app.delete('/api/admin/hangman/words/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: word, error: fetchError } = await supabase
      .from('words')
      .select('image_path')
      .eq('id', id)
      .single();

    if (fetchError) {
      return res.status(404).json({ success: false, message: 'Word not found' });
    }

    if (word.image_path) {
      await deleteFromR2(word.image_path);
    }

    const { error } = await supabase.from('words').delete().eq('id', id);
    if (error) throw error;

    res.json({ success: true, message: 'Word deleted successfully' });
  } catch (error) {
    console.error('Error deleting word:', error);
    res.status(500).json({ success: false, message: 'Failed to delete word: ' + error.message });
  }
});

// Get word statistics (admin)
app.get('/api/admin/hangman/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { count: totalWords, error: totalError } = await supabase
      .from('words')
      .select('*', { count: 'exact', head: true });

    if (totalError) throw totalError;

    const { count: wordsWithImages, error: imageError } = await supabase
      .from('words')
      .select('*', { count: 'exact', head: true })
      .not('image_url', 'is', null);

    if (imageError) throw imageError;

    const { data: categoryData, error: catError } = await supabase
      .from('words')
      .select('category')
      .not('category', 'is', null);

    if (catError) throw catError;

    const categoryDistribution = {};
    categoryData.forEach(item => {
      categoryDistribution[item.category] = (categoryDistribution[item.category] || 0) + 1;
    });

    const { data: difficultyData, error: diffError } = await supabase
      .from('words')
      .select('difficulty');

    if (diffError) throw diffError;

    const difficultyDistribution = {};
    difficultyData.forEach(item => {
      const diff = item.difficulty || 'medium';
      difficultyDistribution[diff] = (difficultyDistribution[diff] || 0) + 1;
    });

    const { data: pointsData, error: pointsError } = await supabase
      .from('words')
      .select('points');

    if (pointsError) throw pointsError;

    let totalPoints = 0;
    pointsData.forEach(item => {
      totalPoints += item.points || 10;
    });
    const avgPoints = pointsData.length > 0 ? Math.round(totalPoints / pointsData.length) : 0;

    res.json({
      success: true,
      stats: {
        totalWords: totalWords || 0,
        wordsWithImages: wordsWithImages || 0,
        avgPoints,
        categories: Object.keys(categoryDistribution).length,
        categoryDistribution,
        difficultyDistribution
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// Extract words + images from PDF for Hangman (admin)
app.post('/api/admin/hangman/import-pdf', authenticateToken, requireAdmin, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'PDF file is required' });
    }

    const { category } = req.body;
    if (!category) {
      return res.status(400).json({ success: false, message: 'Category/subject is required' });
    }

    console.log(`📄 Processing PDF for hangman: ${req.file.originalname} (${req.file.size} bytes) → category: ${category}`);

    const buffer = req.file.buffer;

    // 1. Extract text from PDF
    let text = '';
    if (pdfParse) {
      const pdfData = await pdfParse(buffer);
      text = pdfData.text || '';
      console.log(`📄 Extracted ${text.length} chars of text`);
    }

    // 2. Extract images from PDF using pdf-lib
    const { PDFDocument } = require('pdf-lib');
    const sharp = require('sharp');
    const pdfDoc = await PDFDocument.load(buffer);
    const pages = pdfDoc.getPages();
    const extractedImages = [];

    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
      try {
        const page = pages[pageIdx];
        const resources = page.node.Resources();
        if (!resources) continue;
        
        const xObjects = resources.lookup(require('pdf-lib').PDFName.of('XObject'));
        if (!xObjects) continue;
        
        const entries = xObjects.entries ? xObjects.entries() : [];
        for (const [name, ref] of entries) {
          try {
            const xObject = xObjects.lookup(name);
            if (!xObject) continue;
            
            const subtype = xObject.lookup ? xObject.lookup(require('pdf-lib').PDFName.of('Subtype')) : null;
            if (!subtype || subtype.toString() !== '/Image') continue;

            // Get raw image data
            const imageData = xObject.getContents ? xObject.getContents() : null;
            if (!imageData || imageData.length < 100) continue;

            // Try to upload to R2
            const imgFileName = `hangman/pdf_${Date.now()}_p${pageIdx}_${name.toString().replace('/', '')}.png`;
            
            // Convert to PNG using sharp if possible
            let imgBuffer;
            try {
              imgBuffer = await sharp(Buffer.from(imageData)).png().toBuffer();
            } catch (sharpErr) {
              // If sharp can't process it, try raw as JPEG
              imgBuffer = Buffer.from(imageData);
            }

            const uploadResult = await uploadToR2(imgBuffer, imgFileName, 'image/png');
            if (uploadResult.success) {
              extractedImages.push({
                url: uploadResult.url,
                page: pageIdx + 1,
                name: name.toString()
              });
              console.log(`🖼️ Extracted image from page ${pageIdx + 1}: ${uploadResult.url}`);
            }
          } catch (imgErr) {
            // Skip individual image errors
          }
        }
      } catch (pageErr) {
        console.warn(`⚠️ Could not process page ${pageIdx + 1} images:`, pageErr.message);
      }
    }

    console.log(`🖼️ Extracted ${extractedImages.length} images total`);

    // 3. Use AI to extract structured word-hint pairs from the text
    let words = [];

    if (openaiClient && text.length > 20) {
      try {
        const prompt = `Extract vocabulary words from this educational text for a Hangman game. The subject is "${category}".

For each word found:
- The word itself (single word, 4-12 letters, no spaces)
- A short hint/clue (max 60 chars)
- Difficulty: easy (4-5 letters), medium (6-8 letters), hard (9+ letters)
- Points: easy=2, medium=3, hard=5

Text content:
${text.substring(0, 3000)}

Return ONLY a valid JSON array:
[{"word":"WORD","hint":"short clue","difficulty":"easy|medium|hard","points":2}]

Extract at most 30 words. Focus on key vocabulary terms.`;

        const completion = await openaiClient.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'You are an educational content extractor. Return ONLY valid JSON, no markdown.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3,
          max_tokens: 2000,
        });

        const responseText = completion.choices[0].message.content.trim();
        const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        words = JSON.parse(cleanJson);
        console.log(`🤖 AI extracted ${words.length} words`);
      } catch (aiErr) {
        console.warn('⚠️ AI extraction failed, using basic text parsing:', aiErr.message);
      }
    }

    // 4. Fallback: basic text extraction if AI failed
    if (words.length === 0 && text.length > 0) {
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      for (const line of lines) {
        // Try "word - hint" format
        const match = line.match(/^([A-Za-z]{4,12})\s*[-–:]\s*(.+)$/);
        if (match) {
          words.push({
            word: match[1].toUpperCase(),
            hint: match[2].trim().substring(0, 60),
            difficulty: match[1].length <= 5 ? 'easy' : match[1].length <= 8 ? 'medium' : 'hard',
            points: match[1].length <= 5 ? 2 : match[1].length <= 8 ? 3 : 5
          });
        } else {
          // Try standalone words
          const wordMatch = line.match(/^([A-Za-z]{4,12})$/);
          if (wordMatch) {
            words.push({
              word: wordMatch[1].toUpperCase(),
              hint: `A ${category} term with ${wordMatch[1].length} letters`,
              difficulty: wordMatch[1].length <= 5 ? 'easy' : wordMatch[1].length <= 8 ? 'medium' : 'hard',
              points: wordMatch[1].length <= 5 ? 2 : wordMatch[1].length <= 8 ? 3 : 5
            });
          }
        }
      }
    }

    // 5. Distribute images across words (round-robin if more words than images)
    const wordsWithImages = words.map((w, i) => ({
      ...w,
      word: w.word.toUpperCase().replace(/[^A-Z]/g, ''),
      category: category,
      image_url: extractedImages.length > 0 
        ? extractedImages[i % extractedImages.length]?.url || null 
        : null
    })).filter(w => w.word.length >= 4 && w.word.length <= 12);

    // 6. Save words to database
    const saved = [];
    const errors = [];

    for (const wordData of wordsWithImages) {
      try {
        // Check if word already exists
        const { data: existing } = await supabase
          .from('words')
          .select('id')
          .eq('word', wordData.word)
          .eq('category', category)
          .maybeSingle();

        if (existing) {
          errors.push(`${wordData.word} already exists`);
          continue;
        }

        const { data: newWord, error: insertErr } = await supabase
          .from('words')
          .insert([{
            word: wordData.word,
            category: category,
            hint: wordData.hint || `A ${category} word`,
            difficulty: wordData.difficulty || 'medium',
            points: wordData.points || 3,
            image_url: wordData.image_url || null,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }])
          .select()
          .single();

        if (!insertErr && newWord) {
          saved.push(newWord);
        } else if (insertErr) {
          errors.push(`${wordData.word}: ${insertErr.message}`);
        }
      } catch (e) {
        errors.push(`${wordData.word}: ${e.message}`);
      }
    }

    res.json({
      success: true,
      message: `Imported ${saved.length} words from PDF`,
      words: saved,
      images_extracted: extractedImages.length,
      total_found: wordsWithImages.length,
      saved: saved.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('❌ PDF import error:', error);
    res.status(500).json({ success: false, message: 'Failed to process PDF: ' + error.message });
  }
});

// ============ LEARNER HANGMAN ROUTES ============

// Get words for learners (supports subject filter)
app.get('/api/hangman/words', authenticateToken, async (req, res) => {
  try {
    const { subject } = req.query;
    
    let query = supabase
      .from('words')
      .select('id, word, category, hint, difficulty, points, image_url')
      .eq('is_active', true);
    
    if (subject) {
      query = query.eq('category', subject);
    }
    
    const { data: words, error } = await query
      .order('category', { ascending: true })
      .order('word', { ascending: true });

    if (error) throw error;
    res.json({ success: true, words: words || [], count: words?.length || 0 });
  } catch (error) {
    console.error('Error fetching learner words:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words', words: [] });
  }
});

// Generate hangman words dynamically for a subject using AI
app.post('/api/hangman/generate-words', authenticateToken, async (req, res) => {
  try {
    const { subject, count = 10 } = req.body;
    
    if (!subject) {
      return res.status(400).json({ success: false, message: 'Subject is required' });
    }

    // Subject display names for better prompts
    const subjectNames = {
      'mathematics': 'Mathematics',
      'english': 'English Language',
      'primary-science': 'Primary Science',
      'social-studies': 'Social Studies',
      'bible-knowledge': 'Bible Knowledge',
      'arts-life-skills': 'Arts & Life Skills',
      'chichewa': 'Chichewa Language'
    };

    const subjectName = subjectNames[subject] || subject;

    // First check if we already have enough words for this subject
    const { data: existingWords, error: existingError } = await supabase
      .from('words')
      .select('id, word, category, hint, difficulty, points, image_url')
      .eq('category', subject)
      .eq('is_active', true);

    if (!existingError && existingWords && existingWords.length >= 5) {
      // We have enough words already, return them
      return res.json({ 
        success: true, 
        words: existingWords, 
        count: existingWords.length,
        source: 'database'
      });
    }

    // Generate words using OpenAI if available
    if (!openaiClient) {
      // Fallback: return hardcoded subject words if no AI
      const fallbackWords = getFallbackWordsForSubject(subject);
      
      // Save fallback words to database
      const savedWords = [];
      for (const wordData of fallbackWords) {
        const { data: existing } = await supabase
          .from('words')
          .select('id')
          .eq('word', wordData.word)
          .eq('category', subject)
          .maybeSingle();
        
        if (!existing) {
          const { data: saved, error: saveError } = await supabase
            .from('words')
            .insert([{
              word: wordData.word,
              category: subject,
              hint: wordData.hint,
              difficulty: wordData.difficulty,
              points: wordData.points,
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }])
            .select()
            .single();
          
          if (!saveError && saved) savedWords.push(saved);
        }
      }

      // Fetch all words for this subject
      const { data: allWords } = await supabase
        .from('words')
        .select('id, word, category, hint, difficulty, points, image_url')
        .eq('category', subject)
        .eq('is_active', true);

      return res.json({ 
        success: true, 
        words: allWords || savedWords, 
        count: (allWords || savedWords).length,
        source: 'fallback'
      });
    }

    // Use OpenAI to generate subject-relevant words
    try {
      const prompt = `Generate ${count} vocabulary words for a primary school Hangman game for the subject "${subjectName}" (Standards 5-8 level in Malawi).

Requirements:
- Words should be single words (no spaces), between 4-12 letters
- Words should be common vocabulary terms from this subject
- Include a short hint/clue for each word
- Assign difficulty: easy (4-5 letters), medium (6-8 letters), hard (9-12 letters)
- Words should be educational and age-appropriate for primary school

Return ONLY a valid JSON array with this format:
[{"word": "WORD", "hint": "A short clue", "difficulty": "easy|medium|hard", "points": 2}]

Points: easy=2, medium=3, hard=5`;

      const completion = await openaiClient.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful educational assistant. Return ONLY valid JSON, no markdown or explanations.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 1500,
      });

      let generatedWords = [];
      const responseText = completion.choices[0].message.content.trim();
      
      // Parse the JSON response
      try {
        // Remove markdown code fences if present
        const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        generatedWords = JSON.parse(cleanJson);
      } catch (parseError) {
        console.error('Error parsing AI response:', parseError);
        console.log('Raw response:', responseText);
        // Fallback to predefined words
        generatedWords = getFallbackWordsForSubject(subject);
      }

      // Save generated words to database
      const savedWords = [];
      for (const wordData of generatedWords) {
        if (!wordData.word || wordData.word.includes(' ')) continue;
        
        const upperWord = wordData.word.toUpperCase().replace(/[^A-Z]/g, '');
        if (upperWord.length < 4 || upperWord.length > 12) continue;

        const { data: existing } = await supabase
          .from('words')
          .select('id')
          .eq('word', upperWord)
          .eq('category', subject)
          .maybeSingle();
        
        if (!existing) {
          const { data: saved, error: saveError } = await supabase
            .from('words')
            .insert([{
              word: upperWord,
              category: subject,
              hint: wordData.hint || `A ${subjectName} term`,
              difficulty: wordData.difficulty || 'medium',
              points: wordData.points || 2,
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }])
            .select()
            .single();
          
          if (!saveError && saved) savedWords.push(saved);
        }
      }

      // Fetch all words for this subject
      const { data: allWords } = await supabase
        .from('words')
        .select('id, word, category, hint, difficulty, points, image_url')
        .eq('category', subject)
        .eq('is_active', true);

      return res.json({ 
        success: true, 
        words: allWords || savedWords, 
        count: (allWords || savedWords).length,
        source: 'ai-generated'
      });

    } catch (aiError) {
      console.error('AI generation error:', aiError);
      
      // Fallback to predefined words
      const fallbackWords = getFallbackWordsForSubject(subject);
      const savedWords = [];
      
      for (const wordData of fallbackWords) {
        const { data: existing } = await supabase
          .from('words')
          .select('id')
          .eq('word', wordData.word)
          .eq('category', subject)
          .maybeSingle();
        
        if (!existing) {
          const { data: saved, error: saveError } = await supabase
            .from('words')
            .insert([{
              word: wordData.word,
              category: subject,
              hint: wordData.hint,
              difficulty: wordData.difficulty,
              points: wordData.points,
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }])
            .select()
            .single();
          
          if (!saveError && saved) savedWords.push(saved);
        }
      }

      const { data: allWords } = await supabase
        .from('words')
        .select('id, word, category, hint, difficulty, points, image_url')
        .eq('category', subject)
        .eq('is_active', true);

      return res.json({ 
        success: true, 
        words: allWords || savedWords, 
        count: (allWords || savedWords).length,
        source: 'fallback'
      });
    }
  } catch (error) {
    console.error('Error generating hangman words:', error);
    res.status(500).json({ success: false, message: 'Failed to generate words: ' + error.message });
  }
});

// Fallback words for each subject when AI is unavailable
function getFallbackWordsForSubject(subject) {
  const subjectWords = {
    'mathematics': [
      { word: 'FRACTION', hint: 'Part of a whole number', difficulty: 'medium', points: 3 },
      { word: 'ANGLE', hint: 'Formed where two lines meet', difficulty: 'easy', points: 2 },
      { word: 'DECIMAL', hint: 'Number with a dot', difficulty: 'medium', points: 3 },
      { word: 'DIVIDE', hint: 'Split into equal parts', difficulty: 'medium', points: 3 },
      { word: 'SQUARE', hint: 'Shape with 4 equal sides', difficulty: 'medium', points: 3 },
      { word: 'GRAPH', hint: 'Visual display of data', difficulty: 'easy', points: 2 },
      { word: 'RATIO', hint: 'Comparison of two numbers', difficulty: 'easy', points: 2 },
      { word: 'VOLUME', hint: 'Space inside a 3D shape', difficulty: 'medium', points: 3 },
      { word: 'PERIMETER', hint: 'Distance around a shape', difficulty: 'hard', points: 5 },
      { word: 'MULTIPLY', hint: 'Repeated addition', difficulty: 'medium', points: 3 },
      { word: 'TRIANGLE', hint: 'Shape with 3 sides', difficulty: 'medium', points: 3 },
      { word: 'PERCENT', hint: 'Out of one hundred', difficulty: 'medium', points: 3 },
      { word: 'ALGEBRA', hint: 'Using letters for numbers', difficulty: 'medium', points: 3 },
      { word: 'RADIUS', hint: 'Half of a diameter', difficulty: 'medium', points: 3 },
      { word: 'SYMMETRY', hint: 'Same on both sides', difficulty: 'medium', points: 3 }
    ],
    'english': [
      { word: 'NOUN', hint: 'Name of a person, place or thing', difficulty: 'easy', points: 2 },
      { word: 'VERB', hint: 'An action word', difficulty: 'easy', points: 2 },
      { word: 'ADJECTIVE', hint: 'Describes a noun', difficulty: 'hard', points: 5 },
      { word: 'PRONOUN', hint: 'Replaces a noun', difficulty: 'medium', points: 3 },
      { word: 'ADVERB', hint: 'Modifies a verb', difficulty: 'medium', points: 3 },
      { word: 'TENSE', hint: 'Time of an action', difficulty: 'easy', points: 2 },
      { word: 'PLURAL', hint: 'More than one', difficulty: 'medium', points: 3 },
      { word: 'VOWEL', hint: 'A, E, I, O, U', difficulty: 'easy', points: 2 },
      { word: 'SUFFIX', hint: 'Added to end of a word', difficulty: 'medium', points: 3 },
      { word: 'PREFIX', hint: 'Added to start of a word', difficulty: 'medium', points: 3 },
      { word: 'SYNONYM', hint: 'Word with similar meaning', difficulty: 'medium', points: 3 },
      { word: 'ANTONYM', hint: 'Word with opposite meaning', difficulty: 'medium', points: 3 },
      { word: 'SENTENCE', hint: 'Group of words with meaning', difficulty: 'medium', points: 3 },
      { word: 'PARAGRAPH', hint: 'Group of sentences', difficulty: 'hard', points: 5 },
      { word: 'CONSONANT', hint: 'Not a vowel', difficulty: 'hard', points: 5 }
    ],
    'primary-science': [
      { word: 'OXYGEN', hint: 'Gas we breathe', difficulty: 'medium', points: 3 },
      { word: 'PLANT', hint: 'Living thing that grows in soil', difficulty: 'easy', points: 2 },
      { word: 'ENERGY', hint: 'Power to do work', difficulty: 'medium', points: 3 },
      { word: 'MAGNET', hint: 'Attracts iron', difficulty: 'medium', points: 3 },
      { word: 'GRAVITY', hint: 'Force that pulls things down', difficulty: 'medium', points: 3 },
      { word: 'CELL', hint: 'Basic unit of life', difficulty: 'easy', points: 2 },
      { word: 'HABITAT', hint: 'Where animals live', difficulty: 'medium', points: 3 },
      { word: 'PHOTOSYNTHESIS', hint: 'How plants make food', difficulty: 'hard', points: 5 },
      { word: 'SKELETON', hint: 'Bones of the body', difficulty: 'medium', points: 3 },
      { word: 'EROSION', hint: 'Wearing away of soil', difficulty: 'medium', points: 3 },
      { word: 'BACTERIA', hint: 'Tiny living organisms', difficulty: 'medium', points: 3 },
      { word: 'CIRCUIT', hint: 'Path for electricity', difficulty: 'medium', points: 3 },
      { word: 'LIQUID', hint: 'State of matter that flows', difficulty: 'medium', points: 3 },
      { word: 'FOSSIL', hint: 'Remains of ancient life', difficulty: 'medium', points: 3 },
      { word: 'SPECIES', hint: 'Type of living thing', difficulty: 'medium', points: 3 }
    ],
    'social-studies': [
      { word: 'MALAWI', hint: 'The warm heart of Africa', difficulty: 'medium', points: 3 },
      { word: 'CAPITAL', hint: 'Main city of a country', difficulty: 'medium', points: 3 },
      { word: 'CULTURE', hint: 'Way of life of people', difficulty: 'medium', points: 3 },
      { word: 'DISTRICT', hint: 'Division of a region', difficulty: 'medium', points: 3 },
      { word: 'TRADE', hint: 'Buying and selling goods', difficulty: 'easy', points: 2 },
      { word: 'CONTINENT', hint: 'Large land mass', difficulty: 'hard', points: 5 },
      { word: 'LAKE', hint: 'Large body of fresh water', difficulty: 'easy', points: 2 },
      { word: 'GOVERNMENT', hint: 'Leaders of a country', difficulty: 'hard', points: 5 },
      { word: 'CLIMATE', hint: 'Weather pattern over time', difficulty: 'medium', points: 3 },
      { word: 'BORDER', hint: 'Line between countries', difficulty: 'medium', points: 3 },
      { word: 'EXPORT', hint: 'Goods sent to other countries', difficulty: 'medium', points: 3 },
      { word: 'IMPORT', hint: 'Goods brought from outside', difficulty: 'medium', points: 3 },
      { word: 'POPULATION', hint: 'Number of people', difficulty: 'hard', points: 5 },
      { word: 'DEMOCRACY', hint: 'Government by the people', difficulty: 'hard', points: 5 },
      { word: 'RESOURCE', hint: 'Something useful for people', difficulty: 'medium', points: 3 }
    ],
    'bible-knowledge': [
      { word: 'MOSES', hint: 'Led Israelites from Egypt', difficulty: 'easy', points: 2 },
      { word: 'FAITH', hint: 'Believing without seeing', difficulty: 'easy', points: 2 },
      { word: 'PRAYER', hint: 'Talking to God', difficulty: 'medium', points: 3 },
      { word: 'PARABLE', hint: 'Story with a lesson', difficulty: 'medium', points: 3 },
      { word: 'DISCIPLE', hint: 'Follower of Jesus', difficulty: 'medium', points: 3 },
      { word: 'CREATION', hint: 'God made the world', difficulty: 'medium', points: 3 },
      { word: 'PSALM', hint: 'Song of praise', difficulty: 'easy', points: 2 },
      { word: 'BAPTISM', hint: 'Water ceremony', difficulty: 'medium', points: 3 },
      { word: 'PROPHET', hint: 'Messenger of God', difficulty: 'medium', points: 3 },
      { word: 'GENESIS', hint: 'First book of the Bible', difficulty: 'medium', points: 3 },
      { word: 'MIRACLE', hint: 'Supernatural event', difficulty: 'medium', points: 3 },
      { word: 'COVENANT', hint: 'Promise between God and people', difficulty: 'medium', points: 3 },
      { word: 'TEMPLE', hint: 'Place of worship', difficulty: 'medium', points: 3 },
      { word: 'WISDOM', hint: 'Knowledge and good judgment', difficulty: 'medium', points: 3 },
      { word: 'SABBATH', hint: 'Day of rest', difficulty: 'medium', points: 3 }
    ],
    'arts-life-skills': [
      { word: 'RHYTHM', hint: 'Pattern of beats in music', difficulty: 'medium', points: 3 },
      { word: 'MELODY', hint: 'Tune of a song', difficulty: 'medium', points: 3 },
      { word: 'CANVAS', hint: 'Surface for painting', difficulty: 'medium', points: 3 },
      { word: 'COLOUR', hint: 'Red, blue, green etc.', difficulty: 'medium', points: 3 },
      { word: 'SKETCH', hint: 'Quick drawing', difficulty: 'medium', points: 3 },
      { word: 'HYGIENE', hint: 'Keeping clean and healthy', difficulty: 'medium', points: 3 },
      { word: 'RESPECT', hint: 'Treating others well', difficulty: 'medium', points: 3 },
      { word: 'SAFETY', hint: 'Being free from danger', difficulty: 'medium', points: 3 },
      { word: 'POTTERY', hint: 'Making things from clay', difficulty: 'medium', points: 3 },
      { word: 'WEAVING', hint: 'Making cloth from threads', difficulty: 'medium', points: 3 },
      { word: 'DRAMA', hint: 'Acting out stories', difficulty: 'easy', points: 2 },
      { word: 'DANCE', hint: 'Moving to music', difficulty: 'easy', points: 2 },
      { word: 'EMPATHY', hint: 'Understanding others feelings', difficulty: 'medium', points: 3 },
      { word: 'TEAMWORK', hint: 'Working together', difficulty: 'medium', points: 3 },
      { word: 'NUTRITION', hint: 'Healthy food choices', difficulty: 'hard', points: 5 }
    ],
    'chichewa': [
      { word: 'NYUMBA', hint: 'House in Chichewa', difficulty: 'medium', points: 3 },
      { word: 'MADZI', hint: 'Water in Chichewa', difficulty: 'easy', points: 2 },
      { word: 'SUKULU', hint: 'School in Chichewa', difficulty: 'medium', points: 3 },
      { word: 'BANJA', hint: 'Family in Chichewa', difficulty: 'easy', points: 2 },
      { word: 'CHIMANGA', hint: 'Maize in Chichewa', difficulty: 'medium', points: 3 },
      { word: 'DZUWA', hint: 'Sun in Chichewa', difficulty: 'easy', points: 2 },
      { word: 'MLIMI', hint: 'Farmer in Chichewa', difficulty: 'easy', points: 2 },
      { word: 'NSOMBA', hint: 'Fish in Chichewa', difficulty: 'medium', points: 3 },
      { word: 'CHITEDZE', hint: 'Blanket in Chichewa', difficulty: 'medium', points: 3 },
      { word: 'MTENGO', hint: 'Tree in Chichewa', difficulty: 'medium', points: 3 },
      { word: 'KAMPANI', hint: 'Village in Chichewa', difficulty: 'medium', points: 3 },
      { word: 'THUMBA', hint: 'Bag in Chichewa', difficulty: 'medium', points: 3 },
      { word: 'PHUNZIRO', hint: 'Lesson in Chichewa', difficulty: 'medium', points: 3 },
      { word: 'CHAKA', hint: 'Year in Chichewa', difficulty: 'easy', points: 2 },
      { word: 'MPANDO', hint: 'Chair in Chichewa', difficulty: 'medium', points: 3 }
    ]
  };

  return subjectWords[subject] || subjectWords['english'];
}

// Get available subjects for hangman
app.get('/api/hangman/subjects', authenticateToken, async (req, res) => {
  try {
    const subjects = [
      { id: 'mathematics', name: 'Mathematics', icon: '🔢', color: '#6366f1' },
      { id: 'english', name: 'English', icon: '📚', color: '#3b82f6' },
      { id: 'primary-science', name: 'Science', icon: '🔬', color: '#8b5cf6' },
      { id: 'social-studies', name: 'Social Studies', icon: '🌍', color: '#10b981' },
      { id: 'bible-knowledge', name: 'Bible Knowledge', icon: '📖', color: '#f59e0b' },
      { id: 'arts-life-skills', name: 'Arts & Life Skills', icon: '🎨', color: '#f97316' },
      { id: 'chichewa', name: 'Chichewa', icon: '🇲🇼', color: '#ef4444' }
    ];

    // Get word counts for each subject
    const { data: wordCounts, error } = await supabase
      .from('words')
      .select('category')
      .eq('is_active', true);

    if (!error && wordCounts) {
      const countMap = {};
      wordCounts.forEach(w => {
        countMap[w.category] = (countMap[w.category] || 0) + 1;
      });

      subjects.forEach(s => {
        s.wordCount = countMap[s.id] || 0;
      });
    }

    res.json({ success: true, subjects });
  } catch (error) {
    console.error('Error fetching hangman subjects:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch subjects' });
  }
});

// Get categories for learners
app.get('/api/hangman/categories', authenticateToken, async (req, res) => {
  try {
    const { data: categories, error } = await supabase
      .from('words')
      .select('category')
      .eq('is_active', true)
      .order('category');

    if (error) throw error;

    const categoryMap = {};
    categories.forEach(item => {
      categoryMap[item.category] = (categoryMap[item.category] || 0) + 1;
    });

    const result = Object.entries(categoryMap).map(([category, count]) => ({ category, count }));

    res.json({ success: true, categories: result });
  } catch (error) {
    console.error('Error fetching learner categories:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch categories' });
  }
});

// Track hangman attempt
app.post('/api/hangman/track-attempt', authenticateToken, async (req, res) => {
  try {
    const { wordId, correct, attempts, timeSpent } = req.body;
    const userId = req.user.id;

    if (!wordId) {
      return res.status(400).json({ success: false, message: 'Word ID is required' });
    }

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

    if (attemptError) {
      console.error('Error inserting attempt:', attemptError);
      return res.status(500).json({ success: false, message: 'Failed to track attempt' });
    }

    if (correct) {
      const { data: wordData, error: wordError } = await supabase
        .from('words')
        .select('points')
        .eq('id', wordId)
        .single();

      if (!wordError && wordData) {
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('current_points, lifetime_points')
          .eq('id', userId)
          .single();

        if (!userError && userData) {
          const pointsToAdd = wordData.points || 2;
          const newPoints = (userData.current_points || 0) + pointsToAdd;
          const newLifetimePoints = (userData.lifetime_points || 0) + pointsToAdd;

          await supabase
            .from('users')
            .update({
              current_points: newPoints,
              lifetime_points: newLifetimePoints,
              updated_at: new Date().toISOString()
            })
            .eq('id', userId);
        }
      }
    }

    res.json({ success: true, message: 'Attempt tracked successfully' });
  } catch (error) {
    console.error('Error tracking attempt:', error);
    res.status(500).json({ success: false, message: 'Failed to track attempt: ' + error.message });
  }
});

// Get hangman user stats
app.get('/api/hangman/user-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: attempts, error: attemptsError } = await supabase
      .from('word_attempts')
      .select('correct, attempts, attempted_at, word_id')
      .eq('user_id', userId)
      .order('attempted_at', { ascending: false });

    if (attemptsError) {
      return res.json({
        success: true,
        stats: {
          totalAttempts: 0,
          correctAttempts: 0,
          successRate: 0,
          uniqueWordsCount: 0,
          totalPoints: 0,
          lifetimePoints: 0,
          recentAttempts: []
        }
      });
    }

    const totalAttempts = attempts?.length || 0;
    const correctAttempts = attempts?.filter(a => a.correct).length || 0;
    const successRate = totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0;
    const uniqueWords = [...new Set(attempts?.map(a => a.word_id) || [])];

    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('current_points, lifetime_points')
      .eq('id', userId)
      .single();

    res.json({
      success: true,
      stats: {
        totalAttempts,
        correctAttempts,
        successRate,
        uniqueWordsCount: uniqueWords.length,
        totalPoints: userData?.current_points || 0,
        lifetimePoints: userData?.lifetime_points || 0,
        recentAttempts: (attempts || []).slice(0, 10)
      }
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.json({
      success: true,
      stats: {
        totalAttempts: 0,
        correctAttempts: 0,
        successRate: 0,
        uniqueWordsCount: 0,
        totalPoints: 0,
        lifetimePoints: 0,
        recentAttempts: []
      }
    });
  }
});

// ============ SPELLING BEE ROUTES ============

// Get all active spelling words
app.get('/api/spelling/words', async (req, res) => {
  try {
    const { difficulty } = req.query;
    
    let query = supabase.from('spelling_words').select('*').eq('is_active', true);
    
    if (difficulty && difficulty !== 'all') {
      query = query.eq('difficulty', difficulty);
    }
    
    const { data: words, error } = await query
      .order('difficulty', { ascending: true })
      .order('word', { ascending: true });

    if (error) throw error;
    res.json({ success: true, words });
  } catch (error) {
    console.error('Error fetching spelling words:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words' });
  }
});

// Get spelling words by level
app.get('/api/spelling/words/level/:level', async (req, res) => {
  try {
    const level = parseInt(req.params.level);
    if (level < 1 || level > 10) {
      return res.status(400).json({ success: false, message: 'Invalid level. Must be 1-10.' });
    }

    const { data: words, error } = await supabase
      .from('spelling_words')
      .select('*')
      .eq('level', level)
      .eq('is_active', true)
      .order('difficulty', { ascending: true })
      .order('word', { ascending: true });

    if (error) throw error;

    if (!words || words.length === 0) {
      return res.json({ 
        success: true, 
        words: [],
        message: `No words available for Level ${level}. Please ask an admin to add words.`
      });
    }

    res.json({ success: true, words });
  } catch (error) {
    console.error('Error fetching words by level:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words' });
  }
});

// Track spelling attempt
app.post('/api/spelling/track-attempt', authenticateToken, async (req, res) => {
  try {
    const { wordId, correct, timeSpent, level } = req.body;
    const userId = req.user.id;

    if (!wordId) {
      return res.status(400).json({ success: false, message: 'Word ID is required' });
    }

    const { error: attemptError } = await supabase
      .from('spelling_attempts')
      .insert([{
        user_id: userId,
        word_id: wordId,
        correct: correct || false,
        time_spent: timeSpent || 0,
        level: level || 1,
        attempted_at: new Date().toISOString()
      }]);

    if (attemptError) throw attemptError;

    if (correct) {
      const { data: wordData, error: wordError } = await supabase
        .from('spelling_words')
        .select('points')
        .eq('id', wordId)
        .single();

      if (!wordError && wordData) {
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('current_points, lifetime_points')
          .eq('id', userId)
          .single();

        if (!userError && userData) {
          const pointsToAdd = wordData.points || 10;
          const newPoints = (userData.current_points || 0) + pointsToAdd;
          const newLifetimePoints = (userData.lifetime_points || 0) + pointsToAdd;

          await supabase
            .from('users')
            .update({
              current_points: newPoints,
              lifetime_points: newLifetimePoints,
              updated_at: new Date().toISOString()
            })
            .eq('id', userId);
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error tracking attempt:', error);
    res.status(500).json({ success: false, message: 'Failed to track attempt: ' + error.message });
  }
});

// Get user's spelling stats
app.get('/api/spelling/user-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: attempts, error } = await supabase
      .from('spelling_attempts')
      .select('correct, time_spent, attempted_at, level')
      .eq('user_id', userId)
      .order('attempted_at', { ascending: false });

    if (error) throw error;

    const totalAttempts = attempts.length;
    const correctAttempts = attempts.filter(a => a.correct).length;
    const successRate = totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0;
    const avgTime = totalAttempts > 0 ? Math.round(attempts.reduce((sum, a) => sum + (a.time_spent || 0), 0) / totalAttempts) : 0;

    const levelDistribution = {};
    attempts.forEach(a => {
      const level = a.level || 1;
      levelDistribution[level] = (levelDistribution[level] || 0) + 1;
    });

    res.json({
      success: true,
      stats: {
        totalAttempts,
        correctAttempts,
        successRate,
        avgTime,
        levelDistribution,
        recentAttempts: attempts.slice(0, 10)
      }
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ============ SPELLING BEE ADMIN ROUTES ============

// Get all spelling words (admin)
app.get('/api/spelling/admin/words', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: words, error } = await supabase
      .from('spelling_words')
      .select('*')
      .order('level', { ascending: true })
      .order('difficulty', { ascending: true })
      .order('word', { ascending: true });

    if (error) throw error;
    res.json({ success: true, words: words || [] });
  } catch (error) {
    console.error('Error fetching spelling words:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words' });
  }
});

// Add spelling word (admin)
app.post('/api/spelling/admin/words', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { word, hint, example, difficulty, level, points, is_active } = req.body;

    if (!word || !difficulty || !level) {
      return res.status(400).json({ success: false, message: 'Word, difficulty, and level are required.' });
    }

    if (level < 1 || level > 10) {
      return res.status(400).json({ success: false, message: 'Level must be between 1 and 10.' });
    }

    const { data: existing, error: checkError } = await supabase
      .from('spelling_words')
      .select('id')
      .eq('word', word.toUpperCase())
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ success: false, message: 'This word already exists.' });
    }

    const difficultyPoints = { easy: 5, medium: 10, hard: 15, expert: 20 };

    const newWord = {
      word: word.toUpperCase(),
      hint: hint || '',
      example: example || '',
      difficulty: difficulty,
      level: parseInt(level),
      points: points || difficultyPoints[difficulty] || 10,
      is_active: is_active !== false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('spelling_words')
      .insert([newWord])
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, word: data, message: 'Word added successfully!' });
  } catch (error) {
    console.error('Error adding spelling word:', error);
    res.status(500).json({ success: false, message: 'Failed to add word' });
  }
});

// Update spelling word (admin)
app.put('/api/spelling/admin/words/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { word, hint, example, difficulty, level, points, is_active } = req.body;

    if (!word || !difficulty || !level) {
      return res.status(400).json({ success: false, message: 'Word, difficulty, and level are required.' });
    }

    if (level < 1 || level > 10) {
      return res.status(400).json({ success: false, message: 'Level must be between 1 and 10.' });
    }

    const difficultyPoints = { easy: 5, medium: 10, hard: 15, expert: 20 };

    const updateData = {
      word: word.toUpperCase(),
      hint: hint || '',
      example: example || '',
      difficulty: difficulty,
      level: parseInt(level),
      points: points || difficultyPoints[difficulty] || 10,
      updated_at: new Date().toISOString()
    };

    if (is_active !== undefined) {
      updateData.is_active = is_active;
    }

    const { data, error } = await supabase
      .from('spelling_words')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, word: data, message: 'Word updated successfully!' });
  } catch (error) {
    console.error('Error updating spelling word:', error);
    res.status(500).json({ success: false, message: 'Failed to update word' });
  }
});

// Delete spelling word (admin)
app.delete('/api/spelling/admin/words/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('spelling_words').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true, message: 'Word deleted successfully!' });
  } catch (error) {
    console.error('Error deleting spelling word:', error);
    res.status(500).json({ success: false, message: 'Failed to delete word' });
  }
});

// Bulk import spelling words (admin)
app.post('/api/spelling/admin/words/import', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { words } = req.body;

    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid data format. Expected an array of words.' });
    }

    const difficultyPoints = { easy: 5, medium: 10, hard: 15, expert: 20 };
    let imported = 0;
    let errors = [];

    for (const wordData of words) {
      const { word, hint, example, difficulty, level, points } = wordData;

      if (word && difficulty && level) {
        try {
          const { data: existing, error: checkError } = await supabase
            .from('spelling_words')
            .select('id')
            .eq('word', word.toUpperCase())
            .maybeSingle();

          if (existing) {
            errors.push(`Word "${word}" already exists.`);
            continue;
          }

          const newWord = {
            word: word.toUpperCase(),
            hint: hint || '',
            example: example || '',
            difficulty: difficulty,
            level: parseInt(level) || 1,
            points: points || difficultyPoints[difficulty] || 10,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          const { error } = await supabase.from('spelling_words').insert([newWord]);
          if (error) {
            errors.push(`Failed to import "${word}": ${error.message}`);
          } else {
            imported++;
          }
        } catch (err) {
          errors.push(`Error importing "${word}": ${err.message}`);
        }
      } else {
        errors.push(`Invalid word data: ${JSON.stringify(wordData)}`);
      }
    }

    res.json({
      success: true,
      imported,
      errors: errors.length > 0 ? errors : undefined,
      message: `Successfully imported ${imported} words. ${errors.length} errors.`
    });
  } catch (error) {
    console.error('Error importing spelling words:', error);
    res.status(500).json({ success: false, message: 'Failed to import words' });
  }
});

// ============ SPELLING BEE TIMER SETTINGS ============

// Get timer settings (admin)
app.get('/api/spelling/admin/timer-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('spelling_timer_settings')
      .select('*')
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching timer settings:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    const defaultSettings = {
      defaultTimeLimit: 60,
      timeLimitPerDifficulty: { easy: 60, medium: 45, hard: 30, expert: 20 }
    };

    if (!settings) {
      return res.json({ success: true, settings: defaultSettings });
    }

    res.json({ 
      success: true, 
      settings: {
        defaultTimeLimit: settings.default_time_limit,
        timeLimitPerDifficulty: settings.time_limit_per_difficulty || defaultSettings.timeLimitPerDifficulty
      }
    });
  } catch (error) {
    console.error('Error fetching timer settings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch timer settings' });
  }
});

// Save timer settings (admin)
app.post('/api/spelling/admin/timer-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { defaultTimeLimit, timeLimitPerDifficulty } = req.body;

    if (!defaultTimeLimit || defaultTimeLimit < 10 || defaultTimeLimit > 120) {
      return res.status(400).json({ success: false, message: 'Invalid default time limit. Must be between 10 and 120 seconds.' });
    }

    const settingsData = {
      default_time_limit: defaultTimeLimit,
      time_limit_per_difficulty: timeLimitPerDifficulty || { easy: 60, medium: 45, hard: 30, expert: 20 },
      updated_at: new Date().toISOString(),
      updated_by: req.user.id
    };

    const { data: existing, error: checkError } = await supabase
      .from('spelling_timer_settings')
      .select('id')
      .limit(1)
      .single();

    let result;
    if (existing) {
      const { data, error } = await supabase
        .from('spelling_timer_settings')
        .update(settingsData)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabase
        .from('spelling_timer_settings')
        .insert([settingsData])
        .select()
        .single();
      if (error) throw error;
      result = data;
    }

    res.json({ 
      success: true, 
      settings: {
        defaultTimeLimit: result.default_time_limit,
        timeLimitPerDifficulty: result.time_limit_per_difficulty
      },
      message: 'Timer settings saved successfully!' 
    });
  } catch (error) {
    console.error('Error saving timer settings:', error);
    res.status(500).json({ success: false, message: 'Failed to save timer settings' });
  }
});

// Get timer settings (learners)
app.get('/api/spelling/timer-settings', authenticateToken, async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('spelling_timer_settings')
      .select('*')
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching timer settings:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    const defaultSettings = { defaultTimeLimit: 60, timeLimitPerDifficulty: { easy: 60, medium: 45, hard: 30, expert: 20 } };

    if (!settings) {
      return res.json({ success: true, settings: defaultSettings });
    }

    res.json({ 
      success: true, 
      settings: {
        defaultTimeLimit: settings.default_time_limit,
        timeLimitPerDifficulty: settings.time_limit_per_difficulty || defaultSettings.timeLimitPerDifficulty
      }
    });
  } catch (error) {
    console.error('Error fetching timer settings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch timer settings' });
  }
});

// ============ SPELLING BEE VOICE SETTINGS ============

// Get voice settings (admin)
app.get('/api/spelling/admin/voice-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('spelling_voice_settings')
      .select('*')
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching voice settings:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    const defaultSettings = {
      enabled: true,
      useClonedVoice: false,
      voiceSpeed: 0.9,
      voicePitch: 1.0,
      cloneVoiceData: null
    };

    if (!settings) {
      return res.json({ success: true, settings: defaultSettings });
    }

    res.json({ 
      success: true, 
      settings: {
        enabled: settings.enabled !== false,
        useClonedVoice: settings.use_cloned_voice || false,
        voiceSpeed: parseFloat(settings.voice_speed) || 0.9,
        voicePitch: parseFloat(settings.voice_pitch) || 1.0,
        cloneVoiceData: settings.clone_voice_data || null
      }
    });
  } catch (error) {
    console.error('Error fetching voice settings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch voice settings' });
  }
});

// Save voice settings (admin)
app.post('/api/spelling/admin/voice-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { enabled, useClonedVoice, voiceSpeed, voicePitch, cloneVoiceData } = req.body;

    const settingsData = {
      enabled: enabled !== false,
      use_cloned_voice: useClonedVoice || false,
      voice_speed: voiceSpeed || 0.9,
      voice_pitch: voicePitch || 1.0,
      clone_voice_data: cloneVoiceData || null,
      updated_at: new Date().toISOString(),
      updated_by: req.user.id
    };

    const { data: existing, error: checkError } = await supabase
      .from('spelling_voice_settings')
      .select('id')
      .limit(1)
      .single();

    let result;
    if (existing) {
      const { data, error } = await supabase
        .from('spelling_voice_settings')
        .update(settingsData)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabase
        .from('spelling_voice_settings')
        .insert([settingsData])
        .select()
        .single();
      if (error) throw error;
      result = data;
    }

    res.json({ 
      success: true, 
      settings: {
        enabled: result.enabled,
        useClonedVoice: result.use_cloned_voice,
        voiceSpeed: parseFloat(result.voice_speed) || 0.9,
        voicePitch: parseFloat(result.voice_pitch) || 1.0,
        cloneVoiceData: result.clone_voice_data
      },
      message: 'Voice settings saved successfully!' 
    });
  } catch (error) {
    console.error('Error saving voice settings:', error);
    res.status(500).json({ success: false, message: 'Failed to save voice settings' });
  }
});

// Get voice settings (learners)
app.get('/api/spelling/voice-settings', authenticateToken, async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('spelling_voice_settings')
      .select('*')
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching voice settings:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    const defaultSettings = { enabled: true, useClonedVoice: false, voiceSpeed: 0.9, voicePitch: 1.0 };

    if (!settings) {
      return res.json({ success: true, settings: defaultSettings });
    }

    res.json({ 
      success: true, 
      settings: {
        enabled: settings.enabled !== false,
        useClonedVoice: settings.use_cloned_voice || false,
        voiceSpeed: parseFloat(settings.voice_speed) || 0.9,
        voicePitch: parseFloat(settings.voice_pitch) || 1.0
      }
    });
  } catch (error) {
    console.error('Error fetching voice settings:', error);
    res.json({ 
      success: true, 
      settings: { enabled: true, useClonedVoice: false, voiceSpeed: 0.9, voicePitch: 1.0 }
    });
  }
});

// Delete cloned voice (admin)
app.delete('/api/spelling/admin/clone-voice', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: existing, error: checkError } = await supabase
      .from('spelling_voice_settings')
      .select('id')
      .limit(1)
      .single();

    if (existing) {
      const { error } = await supabase
        .from('spelling_voice_settings')
        .update({
          clone_voice_data: null,
          updated_at: new Date().toISOString(),
          updated_by: req.user.id
        })
        .eq('id', existing.id);

      if (error) {
        console.error('Error deleting clone voice:', error);
        return res.status(400).json({ success: false, message: error.message });
      }
    }

    res.json({ success: true, message: 'Cloned voice deleted successfully' });
  } catch (error) {
    console.error('Error deleting clone voice:', error);
    res.status(500).json({ success: false, message: 'Failed to delete cloned voice' });
  }
});

// ============ SPELLING BEE USER PROGRESS ============

// Get user's spelling progress
app.get('/api/spelling/user-progress', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: progress, error } = await supabase
      .from('spelling_progress')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching progress:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    if (!progress) {
      return res.json({ 
        success: true,
        currentLevel: 1,
        maxUnlockedLevel: 1,
        levelProgress: {},
        totalScore: 0,
        totalWordsCompleted: 0
      });
    }

    res.json({ 
      success: true,
      currentLevel: progress.current_level || 1,
      maxUnlockedLevel: progress.max_unlocked_level || 1,
      levelProgress: progress.level_progress || {},
      totalScore: progress.total_score || 0,
      totalWordsCompleted: progress.total_words_completed || 0
    });
  } catch (error) {
    console.error('Error fetching user progress:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch progress' });
  }
});

// Complete a level
app.post('/api/spelling/level-complete', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { level, score, correctAttempts, totalAttempts } = req.body;

    if (!level || level < 1 || level > 10) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid level. Must be 1-10.' 
      });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('spelling_progress')
      .select('*')
      .eq('user_id', userId)
      .single();

    let levelProgress = {};
    let totalScore = score || 0;
    let totalWordsCompleted = correctAttempts || 0;

    if (existing) {
      levelProgress = existing.level_progress || {};
      totalScore = (existing.total_score || 0) + (score || 0);
      totalWordsCompleted = (existing.total_words_completed || 0) + (correctAttempts || 0);
    }

    levelProgress[level] = {
      completed: true,
      score: score || 0,
      correctAttempts: correctAttempts || 0,
      totalAttempts: totalAttempts || 0,
      completedAt: new Date().toISOString()
    };

    const newMaxUnlockedLevel = Math.min(level + 1, 10);

    if (existing) {
      const { data, error } = await supabase
        .from('spelling_progress')
        .update({
          current_level: Math.min(level + 1, 10),
          max_unlocked_level: newMaxUnlockedLevel,
          level_progress: levelProgress,
          total_score: totalScore,
          total_words_completed: totalWordsCompleted,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('spelling_progress')
        .insert([{
          user_id: userId,
          current_level: Math.min(level + 1, 10),
          max_unlocked_level: newMaxUnlockedLevel,
          level_progress: levelProgress,
          total_score: totalScore,
          total_words_completed: totalWordsCompleted,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }]);

      if (error) throw error;
    }

    res.json({
      success: true,
      message: `Level ${level} completed successfully!`,
      newMaxLevel: newMaxUnlockedLevel
    });
  } catch (error) {
    console.error('Error completing level:', error);
    res.status(500).json({ success: false, message: 'Failed to complete level' });
  }
});

// ============ ADVANCED EXTRACTION ENDPOINT ============
app.post('/api/admin/extract-questions-advanced', authenticateToken, requireAdmin, upload.single('file'), async (req, res) => {
  console.log('='.repeat(50));
  console.log('📄 ADVANCED EXTRACTION REQUEST');
  console.log('='.repeat(50));
  
  try {
    if (!req.file) {
      console.log('❌ No file provided');
      return res.status(400).json({ 
        success: false, 
        message: 'No file provided. Please select a PDF or CSV file.' 
      });
    }

    console.log(`📁 File: ${req.file.originalname}`);
    console.log(`📁 Type: ${req.file.mimetype}`);
    console.log(`📁 Size: ${req.file.size} bytes`);

    let extractedText = '';
    let questions = [];

    // Handle PDF files
    if (req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf')) {
      console.log('🔄 Processing PDF file with advanced parser...');
      
      if (!pdfParse) {
        console.error('❌ PDF parser not available');
        return res.status(500).json({ 
          success: false, 
          message: 'PDF parser is not installed. Please run: npm install pdf-parse@1.1.1' 
        });
      }
      
      try {
        const data = await pdfParse(req.file.buffer);
        extractedText = data.text;
        console.log(`📄 PDF text length: ${extractedText.length} characters`);
        
        questions = extractQuestionsFromText(extractedText);
        console.log(`✅ Extracted ${questions.length} questions from PDF`);

        // Extract images from PDF and upload to R2
        try {
          const { PDFDocument, PDFName } = require('pdf-lib');
          const sharp = require('sharp');
          const pdfDoc = await PDFDocument.load(req.file.buffer);
          const pages = pdfDoc.getPages();
          const extractedImages = [];

          for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
            try {
              const page = pages[pageIdx];
              const resources = page.node.Resources();
              if (!resources) continue;
              
              const xObjects = resources.lookup(PDFName.of('XObject'));
              if (!xObjects) continue;
              
              const entries = xObjects.entries ? xObjects.entries() : [];
              for (const [name, ref] of entries) {
                try {
                  const xObject = xObjects.lookup(name);
                  if (!xObject) continue;
                  
                  const subtype = xObject.lookup ? xObject.lookup(PDFName.of('Subtype')) : null;
                  if (!subtype || subtype.toString() !== '/Image') continue;

                  const imageData = xObject.getContents ? xObject.getContents() : null;
                  if (!imageData || imageData.length < 500) continue;

                  const imgFileName = `quiz-images/pdf_${Date.now()}_p${pageIdx}_${name.toString().replace('/', '')}.png`;
                  
                  let imgBuffer;
                  try {
                    imgBuffer = await sharp(Buffer.from(imageData)).png().toBuffer();
                  } catch (sharpErr) {
                    imgBuffer = Buffer.from(imageData);
                  }

                  const uploadResult = await uploadToR2(imgBuffer, imgFileName, 'image/png');
                  if (uploadResult.success) {
                    extractedImages.push({ url: uploadResult.url, page: pageIdx + 1 });
                    console.log(`🖼️ Extracted image from page ${pageIdx + 1}`);
                  }
                } catch (imgErr) { /* skip */ }
              }
            } catch (pageErr) { /* skip page */ }
          }

          // Distribute images to questions (match by page proximity)
          if (extractedImages.length > 0 && questions.length > 0) {
            console.log(`🖼️ Linking ${extractedImages.length} images to ${questions.length} questions`);
            const questionsPerImage = Math.ceil(questions.length / extractedImages.length);
            for (let i = 0; i < questions.length; i++) {
              const imgIdx = Math.min(Math.floor(i / questionsPerImage), extractedImages.length - 1);
              questions[i].questionImage = extractedImages[imgIdx].url;
              questions[i].layout = 'image-left';
            }
          }
        } catch (imgExtractErr) {
          console.warn('⚠️ Image extraction skipped:', imgExtractErr.message);
        }
        
      } catch (pdfError) {
        console.error('❌ PDF parsing error:', pdfError);
        return res.status(400).json({ 
          success: false, 
          message: `Failed to parse PDF: ${pdfError.message}` 
        });
      }
    }
    // Handle CSV files
    else if (req.file.mimetype === 'text/csv' || req.file.originalname.toLowerCase().endsWith('.csv')) {
      console.log('🔄 Processing CSV file with advanced parser...');
      
      try {
        const csvText = req.file.buffer.toString('utf-8');
        const lines = csvText.split('\n');
        
        if (lines.length < 2) {
          throw new Error('CSV must have at least a header row and one data row');
        }
        
        const firstRow = lines[0].toLowerCase();
        const hasHeader = firstRow.includes('question') || firstRow.includes('option');
        const startRow = hasHeader ? 1 : 0;
        
        for (let i = startRow; i < Math.min(lines.length, 500); i++) {
          if (!lines[i].trim()) continue;
          
          const values = parseCSVRow(lines[i]);
          if (values.length < 5) continue;
          
          const questionText = values[0]?.trim();
          const options = [
            values[1]?.trim() || '',
            values[2]?.trim() || '',
            values[3]?.trim() || '',
            values[4]?.trim() || ''
          ];
          let correctAnswer = values[5]?.trim() || '';
          
          if (correctAnswer && correctAnswer.match(/^[A-D]$/i)) {
            const letterIndex = correctAnswer.toUpperCase().charCodeAt(0) - 65;
            correctAnswer = options[letterIndex] || options[0];
          }
          
          for (let j = 0; j < options.length; j++) {
            if (options[j].includes('✓') || options[j].includes('*') || options[j].includes('(correct)')) {
              correctAnswer = options[j].replace(/[✓*]/g, '').replace(/\(correct\)/i, '').trim();
              options[j] = correctAnswer;
              break;
            }
          }
          
          if (questionText && options.some(o => o)) {
            questions.push({
              id: `csv-${Date.now()}-${questions.length}`,
              question: questionText.toLowerCase(),
              options: ensureFourOptions(options),
              correctAnswer: correctAnswer || options[0] || '',
              layout: 'text-first',
              questionImage: '',
              difficulty: 'intermediate'
            });
          }
        }
        
        console.log(`✅ Extracted ${questions.length} questions from CSV`);
        
      } catch (csvError) {
        console.error('❌ CSV parsing error:', csvError);
        return res.status(400).json({ 
          success: false, 
          message: `Failed to parse CSV: ${csvError.message}` 
        });
      }
    }
    // Handle DOCX files
    else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
             req.file.originalname.toLowerCase().endsWith('.docx')) {
      console.log('🔄 Processing DOCX file...');
      
      try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        extractedText = result.value;
        console.log(`📄 DOCX text length: ${extractedText.length} characters`);
        
        questions = extractQuestionsFromText(extractedText);
        console.log(`✅ Extracted ${questions.length} questions from DOCX`);
        
      } catch (docxError) {
        console.error('❌ DOCX parsing error:', docxError);
        return res.status(400).json({ 
          success: false, 
          message: `Failed to parse DOCX: ${docxError.message}. Please install mammoth: npm install mammoth` 
        });
      }
    }
    else {
      return res.status(400).json({ 
        success: false, 
        message: 'Unsupported file type. Please upload PDF, CSV, or DOCX files.' 
      });
    }

    if (questions.length === 0) {
      console.log('❌ No questions extracted');
      return res.status(400).json({ 
        success: false, 
        message: 'No valid questions found. Please ensure the file has properly formatted questions with options A, B, C, D.' 
      });
    }

    questions = questions.filter(q => {
      const hasQuestion = q.question && q.question.trim().length > 0;
      const hasValidOptions = q.options && q.options.some(opt => opt && opt.trim().length > 0);
      const hasCorrectAnswer = q.correctAnswer && q.correctAnswer.trim().length > 0;
      return hasQuestion && hasValidOptions && hasCorrectAnswer;
    });

    questions = questions.map(q => {
      let correctAnswer = q.correctAnswer;
      if (!q.options.includes(correctAnswer)) {
        correctAnswer = q.options[0] || '';
      }
      return {
        ...q,
        options: ensureFourOptions(q.options),
        correctAnswer: correctAnswer
      };
    });

    const seenQuestions = new Set();
    const uniqueQuestions = [];
    for (const q of questions) {
      const normalizedQuestion = q.question.toLowerCase().trim();
      if (!seenQuestions.has(normalizedQuestion)) {
        seenQuestions.add(normalizedQuestion);
        uniqueQuestions.push(q);
      }
    }

    console.log(`✅ SUCCESS: Returning ${uniqueQuestions.length} unique questions from ${questions.length} total`);

    // ── AI Formatting: clean up question text and options ──
    let formattedQuestions = uniqueQuestions;
    if (openaiClient && uniqueQuestions.length > 0) {
      try {
        console.log('🤖 AI formatting questions...');
        
        // Process in batches of 10 to stay within token limits
        const BATCH_SIZE = 10;
        const allFormatted = [];
        
        for (let b = 0; b < uniqueQuestions.length; b += BATCH_SIZE) {
          const batch = uniqueQuestions.slice(b, b + BATCH_SIZE);
          
          const prompt = `You are a quiz formatter. Clean and properly format these quiz questions. Fix:
- Remove numbering prefixes (1., Q1:, etc.)
- Remove letter prefixes from options (A., B), C. etc.)
- Fix broken text, encoding issues, extra spaces
- Make sure the question ends with a question mark if it's a question
- Make sure each option is clean text (no bullets, no letters, no special chars)
- Make sure correctAnswer exactly matches one of the options
- Do NOT change the meaning or content, only clean formatting

Input questions:
${JSON.stringify(batch.map(q => ({
  question: q.question,
  options: q.options,
  correctAnswer: q.correctAnswer
})))}

Return ONLY a valid JSON array with the same structure:
[{"question":"clean question?","options":["opt1","opt2","opt3","opt4"],"correctAnswer":"matching option"}]`;

          const completion = await openaiClient.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: 'You format quiz questions. Return ONLY valid JSON arrays. No markdown, no explanations.' },
              { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            max_tokens: 3000,
          });

          const responseText = completion.choices[0].message.content.trim();
          const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          
          try {
            const formatted = JSON.parse(cleanJson);
            // Merge AI-formatted text back with original metadata (images, layout, etc.)
            for (let i = 0; i < batch.length; i++) {
              if (formatted[i]) {
                allFormatted.push({
                  ...batch[i],
                  question: String(formatted[i].question || batch[i].question || '').toLowerCase(),
                  options: formatted[i].options || batch[i].options,
                  correctAnswer: formatted[i].correctAnswer || batch[i].correctAnswer,
                });
              } else {
                allFormatted.push(batch[i]);
              }
            }
          } catch (parseErr) {
            console.warn('⚠️ AI format parse failed for batch, keeping originals');
            allFormatted.push(...batch);
          }
        }
        
        formattedQuestions = allFormatted;
        console.log(`✅ AI formatted ${formattedQuestions.length} questions`);
      } catch (aiErr) {
        console.warn('⚠️ AI formatting failed, returning unformatted:', aiErr.message);
        formattedQuestions = uniqueQuestions;
      }
    }

    console.log('='.repeat(50));
    
    res.json({
      success: true,
      questions: formattedQuestions,
      stats: {
        total_extracted: questions.length,
        unique: formattedQuestions.length,
        duplicates_removed: questions.length - uniqueQuestions.length,
        ai_formatted: openaiClient ? true : false
      },
      message: `Successfully extracted ${formattedQuestions.length} questions from ${req.file.originalname}.`
    });
    
  } catch (error) {
    console.error('❌ FATAL ERROR:', error);
    console.error('Stack:', error.stack);
    console.log('='.repeat(50));
    
    res.status(500).json({ 
      success: false, 
      message: `Server error: ${error.message}` 
    });
  }
});

// ============ QUESTION BANK ENDPOINTS ============

app.get('/api/admin/question-bank', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { subject_id, difficulty_level, class_level, page = 1, limit = 20 } = req.query;
    
    let query = supabase.from('questions').select('*', { count: 'exact' });
    
    if (subject_id && subject_id !== 'undefined' && subject_id !== '') {
      query = query.eq('subject_id', subject_id);
    }
    if (difficulty_level && difficulty_level !== 'undefined' && difficulty_level !== '') {
      query = query.eq('difficulty_level', difficulty_level);
    }
    if (class_level && class_level !== 'undefined' && class_level !== '') {
      query = query.eq('class_level', class_level);
    }
    
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    
    const { data: questions, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);
    
    if (error) {
      console.error('Error fetching questions:', error);
      return res.status(400).json({ success: false, error: error.message });
    }
    
    const parsedQuestions = (questions || []).map(q => ({
      ...q,
      options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
      tags: q.tags || []
    }));
    
    res.json({
      success: true,
      questions: parsedQuestions,
      total: count || 0,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Error fetching question bank:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/question-bank/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: questions, error } = await supabase
      .from('questions')
      .select('subject_id, difficulty_level');
    
    if (error) {
      console.error('Error fetching stats:', error);
      return res.status(400).json({ success: false, error: error.message });
    }
    
    const stats = {};
    (questions || []).forEach(q => {
      const subject = q.subject_id || 'uncategorized';
      if (!stats[subject]) {
        stats[subject] = {
          total: 0,
          byDifficulty: {
            beginner: 0,
            easy: 0,
            medium: 0,
            hard: 0,
            expert: 0
          },
          avgSuccessRate: 0
        };
      }
      
      stats[subject].total++;
      
      const difficulty = q.difficulty_level || 'medium';
      if (stats[subject].byDifficulty[difficulty] !== undefined) {
        stats[subject].byDifficulty[difficulty]++;
      }
    });
    
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error fetching question bank stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/question-bank', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📝 Received request to save question to bank');
  
  try {
    const {
      subject_id,
      difficulty_level,
      class_level,
      question,
      options,
      correct_answer,
      explanation,
      points,
      time_limit,
      tags
    } = req.body;
    
    if (!subject_id) {
      return res.status(400).json({ success: false, error: 'subject_id is required' });
    }
    if (!difficulty_level) {
      return res.status(400).json({ success: false, error: 'difficulty_level is required' });
    }
    if (!class_level) {
      return res.status(400).json({ success: false, error: 'class_level is required' });
    }
    if (!question || question.trim() === '') {
      return res.status(400).json({ success: false, error: 'question text is required' });
    }
    if (!options || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ success: false, error: 'at least 2 options are required' });
    }
    if (!correct_answer || correct_answer.trim() === '') {
      return res.status(400).json({ success: false, error: 'correct_answer is required' });
    }
    
    const newQuestion = {
      subject_id: subject_id,
      difficulty_level: difficulty_level,
      class_level: class_level,
      question: question.trim().toLowerCase(),
      options: JSON.stringify(options),
      correct_answer: correct_answer,
      explanation: explanation || null,
      points: points || 2,
      time_limit: time_limit || 30,
      tags: JSON.stringify(tags || []),
      usage_count: 0,
      success_rate: 0,
      created_by: req.user.id,
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const { data, error } = await supabase
      .from('questions')
      .insert([newQuestion])
      .select()
      .single();
    
    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }
    
    console.log('✅ Question saved successfully with ID:', data.id);
    
    res.json({
      success: true,
      id: data.id,
      message: 'Question added successfully'
    });
  } catch (error) {
    console.error('Error saving question:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/question-bank/bulk-import', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📦 Bulk import request received');
  
  try {
    const { questions: questionsToImport, subject_id, difficulty_level, class_level } = req.body;
    
    if (!questionsToImport || !Array.isArray(questionsToImport) || questionsToImport.length === 0) {
      return res.status(400).json({ success: false, error: 'No questions to import' });
    }
    
    let savedCount = 0;
    let failedCount = 0;
    const errors = [];
    
    for (const q of questionsToImport) {
      try {
        const newQuestion = {
          subject_id: subject_id,
          difficulty_level: difficulty_level,
          class_level: class_level,
          question: q.question.trim().toLowerCase(),
          options: JSON.stringify(q.options),
          correct_answer: q.correctAnswer,
          explanation: q.explanation || null,
          points: q.points || 2,
          time_limit: q.time_limit || 30,
          tags: JSON.stringify(q.tags || []),
          usage_count: 0,
          success_rate: 0,
          created_by: req.user.id,
          created_at: new Date(),
          updated_at: new Date()
        };
        
        const { error } = await supabase
          .from('questions')
          .insert([newQuestion]);
        
        if (error) {
          failedCount++;
          errors.push({ question: q.question.substring(0, 50), error: error.message });
        } else {
          savedCount++;
        }
      } catch (err) {
        failedCount++;
        errors.push({ question: q.question.substring(0, 50), error: err.message });
      }
    }
    
    console.log(`✅ Bulk import complete: ${savedCount} saved, ${failedCount} failed`);
    
    res.json({
      success: true,
      savedCount,
      failedCount,
      errors: errors.slice(0, 10),
      message: `Successfully imported ${savedCount} questions to question bank`
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ ADMIN DASHBOARD ENDPOINTS ============

app.get('/api/admin/activities', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📊 Fetching admin activities...');
  
  try {
    const activities = [];
    
    const { data: submissions, error: submissionsError } = await supabase
      .from('quiz_submissions')
      .select('id, score, submitted_at, user_id, quiz_id')
      .order('submitted_at', { ascending: false })
      .limit(20);
    
    if (!submissionsError && submissions && submissions.length > 0) {
      for (const sub of submissions) {
        const { data: userData } = await supabase
          .from('users')
          .select('username, full_name')
          .eq('id', sub.user_id)
          .single();
        
        const { data: quizData } = await supabase
          .from('quizzes')
          .select('title')
          .eq('id', sub.quiz_id)
          .single();
        
        activities.push({
          id: `sub-${sub.id}`,
          type: 'quiz_submitted',
          message: `${userData?.full_name || userData?.username || 'A learner'} completed quiz "${quizData?.title || 'Quiz'}" with ${sub.score}%`,
          timestamp: sub.submitted_at,
          user: userData?.full_name || userData?.username,
          details: { score: sub.score, quizId: sub.quiz_id }
        });
      }
    }
    
    const { data: newLearners, error: learnersError } = await supabase
      .from('users')
      .select('id, full_name, username, created_at, class_level')
      .eq('role', 'learner')
      .order('created_at', { ascending: false })
      .limit(10);
    
    if (!learnersError && newLearners && newLearners.length > 0) {
      newLearners.forEach(learner => {
        activities.push({
          id: `learner-${learner.id}`,
          type: 'learner_registered',
          message: `New learner "${learner.full_name || learner.username}" registered${learner.class_level ? ` for ${learner.class_level}` : ''}`,
          timestamp: learner.created_at,
          user: learner.full_name || learner.username,
          details: { classLevel: learner.class_level }
        });
      });
    }
    
    const { data: newQuizzes, error: quizzesError } = await supabase
      .from('quizzes')
      .select('id, title, created_at, topic')
      .order('created_at', { ascending: false })
      .limit(10);
    
    if (!quizzesError && newQuizzes && newQuizzes.length > 0) {
      newQuizzes.forEach(quiz => {
        activities.push({
          id: `quiz-${quiz.id}`,
          type: 'quiz_created',
          message: `New quiz "${quiz.title}" created in ${quiz.topic}`,
          timestamp: quiz.created_at,
          user: 'Admin',
          details: { topic: quiz.topic }
        });
      });
    }
    
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    console.log(`✅ Found ${activities.length} activities`);
    
    res.json({
      success: true,
      activities: activities.slice(0, 30)
    });
    
  } catch (error) {
    console.error('Get activities error:', error);
    res.status(500).json({ error: 'Failed to fetch activities', message: error.message });
  }
});

app.get('/api/admin/dashboard-stats', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📊 Fetching dashboard statistics...');
  
  try {
    const { count: totalLearners, error: learnersError } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'learner');
    
    const { count: totalQuizzes, error: quizzesError } = await supabase
      .from('quizzes')
      .select('id', { count: 'exact', head: true });
    
    const { count: totalSubmissions, error: submissionsError } = await supabase
      .from('quiz_submissions')
      .select('id', { count: 'exact', head: true });
    
    const { data: pointsData, error: pointsError } = await supabase
      .from('users')
      .select('lifetime_points')
      .eq('role', 'learner');
    
    const totalPoints = pointsData?.reduce((sum, user) => sum + (user.lifetime_points || 0), 0) || 0;
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    const { count: activeLearners, error: activeError } = await supabase
      .from('quiz_submissions')
      .select('user_id', { count: 'exact', head: true })
      .gte('submitted_at', oneWeekAgo.toISOString());
    
    const { data: scoreData, error: scoreError } = await supabase
      .from('quiz_submissions')
      .select('score');
    
    const avgScore = scoreData && scoreData.length > 0
      ? Math.round(scoreData.reduce((sum, s) => sum + (s.score || 0), 0) / scoreData.length)
      : 0;
    
    const { count: totalQuestions, error: questionsError } = await supabase
      .from('questions')
      .select('id', { count: 'exact', head: true });
    
    console.log(`✅ Stats: Learners=${totalLearners}, Quizzes=${totalQuizzes}, Questions=${totalQuestions}`);
    
    res.json({
      success: true,
      stats: {
        total_learners: totalLearners || 0,
        total_quizzes: totalQuizzes || 0,
        total_questions: totalQuestions || 0,
        total_submissions: totalSubmissions || 0,
        total_points_awarded: totalPoints,
        active_learners_this_week: activeLearners || 0,
        average_quiz_score: avgScore
      }
    });
    
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
  }
});

// ============ IMAGE UPLOAD ENDPOINT ============
app.post('/api/admin/upload-image', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const fileExtension = path.extname(req.file.originalname);
    const fileName = `${uuidv4()}${fileExtension}`;
    const fileKey = `quizzes/${fileName}`;

    const command = new PutObjectCommand({
      Bucket: process.env.CLOUDFLARE_R2_BUCKET,
      Key: fileKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });

    await r2Client.send(command);

    const imageUrl = `${process.env.CLOUDFLARE_PUBLIC_URL}/${fileKey}`;

    res.json({
      success: true,
      imageUrl: imageUrl,
      message: 'Image uploaded successfully'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// ============ AUTHENTICATION ENDPOINTS ============

app.post('/api/auth/login', async (req, res) => {
  console.log('📨 Admin login request:', { username: req.body.username });
  
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, full_name, role, password_hash')
      .eq('username', username.trim())
      .eq('role', 'admin');

    if (error || !users || users.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = users[0];

    if (!user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name || user.username,
        role: user.role
      }
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

app.post('/api/auth/learner-login', async (req, res) => {
  try {
    const { username, registrationNumber } = req.body;

    if (!username || !registrationNumber) {
      return res.status(400).json({ error: 'Username and registration number required' });
    }

    const normalizedUsername = username.trim();
    const normalizedRegNumber = registrationNumber.trim();

    let user = null;

    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'learner')
      .eq('username', normalizedUsername)
      .ilike('registration_number', normalizedRegNumber);

    if (!error && users && users.length > 0) {
      user = users[0];
    } else {
      const { data: fullNameUsers, error: fullNameError } = await supabase
        .from('users')
        .select('*')
        .eq('role', 'learner')
        .ilike('full_name', normalizedUsername)
        .ilike('registration_number', normalizedRegNumber);

      if (!fullNameError && fullNameUsers && fullNameUsers.length > 0) {
        user = fullNameUsers[0];
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        classLevel: user.class_level,
        currentPoints: user.current_points || 0,
        lifetimePoints: user.lifetime_points || 0,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Learner login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============ LEARNER ENDPOINTS ============

app.get('/api/learner/balance', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: users, error } = await supabase
      .from('users')
      .select('current_points, lifetime_points')
      .eq('id', userId);

    if (error || !users || users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];
    res.json({
      success: true,
      current_points: user.current_points || 0,
      lifetime_points: user.lifetime_points || 0
    });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

app.get('/api/learner/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId);

    if (error || !users || users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const learner = users[0];
    const maxLevel = learner.class_level || 'standard-8';
    const maxLevelIndex = ALL_LEVELS.indexOf(maxLevel);
    const unlockedLevels = ALL_LEVELS.slice(0, maxLevelIndex + 1);

    res.json({ 
      success: true, 
      learner: {
        ...learner,
        max_level: maxLevel,
        unlocked_levels: unlockedLevels
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ============ LEARNER QUIZZES ENDPOINT ============
app.get('/api/learner/quizzes', authenticateToken, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const userId = req.user.id;

    const { data: learnerData, error: learnerError } = await supabase
      .from('users')
      .select('class_level, current_level')
      .eq('id', userId)
      .single();

    if (learnerError) {
      console.error('Error fetching learner data:', learnerError);
      return res.status(400).json({ error: learnerError.message });
    }

    const learnerClass = learnerData?.class_level;
    const currentLevel = learnerData?.current_level || learnerClass || 'standard-5';
    const allowedLevel = currentLevel;

    console.log(`📚 Learner ${userId}: Class=${learnerClass}, Current Level=${currentLevel}, Allowed Level=${allowedLevel}`);

    const { data: quizzes, error: quizzesError } = await supabase
      .from('quizzes')
      .select('*')
      .eq('is_active', true)
      .or(`start_time.lte.${now},start_time.is.null`)
      .or(`end_time.gte.${now},end_time.is.null`)
      .order('created_at', { ascending: false });

    if (quizzesError) {
      return res.status(400).json({ error: quizzesError.message });
    }

    const { data: assignments, error: assignmentsError } = await supabase
      .from('class_assignments')
      .select('quiz_id, class_level');

    const quizClassMap = {};
    if (!assignmentsError && assignments) {
      assignments.forEach(assignment => {
        if (!quizClassMap[assignment.quiz_id]) {
          quizClassMap[assignment.quiz_id] = [];
        }
        quizClassMap[assignment.quiz_id].push(assignment.class_level);
      });
    }

    const filteredQuizzes = quizzes.filter(quiz => {
      const assignedClasses = quizClassMap[quiz.id] || [];
      const classMatch = assignedClasses.length === 0 || assignedClasses.includes(learnerClass);
      
      const quizLevel = quiz.class_level;
      let levelMatch = true;
      
      if (quizLevel) {
        levelMatch = quizLevel === currentLevel;
      }
      
      return classMatch && levelMatch;
    });

    res.json({ 
      success: true, 
      quizzes: filteredQuizzes,
      learner_progress: {
        current_level: currentLevel,
        class_level: learnerClass,
        next_level: getNextLevel(currentLevel, learnerClass)
      }
    });
    
  } catch (error) {
    console.error('Get quizzes error:', error);
    res.status(500).json({ error: 'Failed to fetch quizzes' });
  }
});

function getNextLevel(currentLevel, classLevel) {
  const currentIndex = ALL_LEVELS.indexOf(currentLevel);
  const classIndex = ALL_LEVELS.indexOf(classLevel);
  
  if (currentIndex < classIndex) {
    return ALL_LEVELS[currentIndex + 1];
  }
  return null;
}

// ============ LEVEL PROGRESSION ENDPOINTS ============

app.get('/api/learner/progress', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: learner, error: learnerError } = await supabase
      .from('users')
      .select('current_level, completed_levels, class_level')
      .eq('id', userId)
      .single();

    if (learnerError) {
      return res.status(400).json({ error: learnerError.message });
    }

    const { data: completions, error: completionError } = await supabase
      .from('level_completion')
      .select('level, completed_at, score_percentage')
      .eq('user_id', userId)
      .order('completed_at', { ascending: true });

    const currentLevelIndex = ALL_LEVELS.indexOf(learner.current_level);
    const unlockedLevels = ALL_LEVELS.slice(0, currentLevelIndex + 1);
    const lockedLevels = ALL_LEVELS.slice(currentLevelIndex + 1);
    const classIndex = ALL_LEVELS.indexOf(learner.class_level);
    const canAdvance = currentLevelIndex < classIndex;

    res.json({
      success: true,
      progress: {
        current_level: learner.current_level,
        completed_levels: completions || [],
        unlocked_levels: unlockedLevels,
        locked_levels: lockedLevels,
        all_levels: ALL_LEVELS,
        class_level: learner.class_level,
        can_advance: canAdvance,
        next_level: canAdvance ? ALL_LEVELS[currentLevelIndex + 1] : null
      }
    });
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

app.post('/api/learner/advance-level', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { current_level, next_level, score_percentage, quizzes_passed, total_quizzes } = req.body;

    const { data: learner, error: learnerError } = await supabase
      .from('users')
      .select('class_level, current_level')
      .eq('id', userId)
      .single();

    if (learnerError) {
      return res.status(400).json({ error: learnerError.message });
    }

    const currentIndex = ALL_LEVELS.indexOf(current_level);
    const nextIndex = ALL_LEVELS.indexOf(next_level);
    const classIndex = ALL_LEVELS.indexOf(learner.class_level);

    if (nextIndex > classIndex) {
      return res.status(400).json({ 
        error: `Cannot advance beyond your class level (${learner.class_level})`,
        max_level: learner.class_level
      });
    }

    if (nextIndex === -1 || nextIndex <= currentIndex) {
      return res.status(400).json({ error: 'Invalid level progression' });
    }

    await supabase
      .from('level_completion')
      .insert([{
        user_id: userId,
        level: current_level,
        completed_at: new Date(),
        score_percentage: score_percentage,
        quizzes_passed: quizzes_passed,
        total_quizzes: total_quizzes
      }]);

    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update({ current_level: next_level })
      .eq('id', userId)
      .select()
      .single();

    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    res.json({
      success: true,
      message: `Advanced to ${next_level}!`,
      new_level: next_level,
      max_level: learner.class_level,
      is_max_level: nextIndex === classIndex
    });
  } catch (error) {
    console.error('Advance level error:', error);
    res.status(500).json({ error: 'Failed to advance level' });
  }
});

// ============ LEARNER QUIZ ENDPOINTS ============
app.get('/api/learner/quiz/:quizId', authenticateToken, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { random = 'false', limit = '20' } = req.query;

    const { data: quizzes, error } = await supabase
      .from('quizzes')
      .select('*')
      .eq('id', quizId);

    if (error || !quizzes || quizzes.length === 0) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const quiz = quizzes[0];
    const now = new Date();
    
    if (!quiz.is_active) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    if (quiz.start_time && new Date(quiz.start_time) > now) {
      return res.status(404).json({ error: 'Quiz not available yet' });
    }
    if (quiz.end_time && new Date(quiz.end_time) < now) {
      return res.status(404).json({ error: 'Quiz is no longer available' });
    }

    let questions = quiz.questions;
    const shouldRandomize = random === 'true' || quiz.random_selection === true;
    
    if (shouldRandomize) {
      const numQuestions = parseInt(limit) || quiz.questions_per_attempt || 20;
      questions = selectRandomQuestions(questions, numQuestions);
    }
    
    const randomizedQuestions = randomizeQuizQuestions(questions);

    res.json({ 
      success: true, 
      quiz: {
        ...quiz,
        questions: randomizedQuestions,
        total_questions_available: quiz.questions?.length || 0,
        selected_questions: randomizedQuestions.length
      }
    });
  } catch (error) {
    console.error('Get quiz error:', error);
    res.status(500).json({ error: 'Failed to fetch quiz' });
  }
});

app.post('/api/learner/quiz-submit', authenticateToken, async (req, res) => {
  try {
    const { quizId, answers, score, pointsEarned } = req.body;
    const userId = req.user.id;

    if (!quizId || !answers) {
      return res.status(400).json({ error: 'Quiz ID and answers required' });
    }

    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select('id, difficulty, class_level')
      .eq('id', quizId)
      .single();

    if (quizError) {
      return res.status(400).json({ error: 'Quiz not found' });
    }

    const { data: submission, error: submitError } = await supabase
      .from('quiz_submissions')
      .insert([
        {
          user_id: userId,
          quiz_id: quizId,
          answers,
          score,
          submitted_at: new Date()
        }
      ])
      .select()
      .single();

    if (submitError) {
      return res.status(400).json({ error: submitError.message });
    }

    if (score >= 60 && pointsEarned && pointsEarned > 0) {
      const { data: users, error: userError } = await supabase
        .from('users')
        .select('current_points, lifetime_points')
        .eq('id', userId)
        .single();

      if (!userError && users) {
        const newCurrentPoints = (users.current_points || 0) + pointsEarned;
        const newLifetimePoints = (users.lifetime_points || 0) + pointsEarned;
        
        await supabase
          .from('users')
          .update({
            current_points: newCurrentPoints,
            lifetime_points: newLifetimePoints
          })
          .eq('id', userId);
      }
    }

    res.json({ 
      success: true, 
      submission: submission, 
      pointsAwarded: score >= 60 ? pointsEarned : 0
    });
  } catch (error) {
    console.error('Quiz submit error:', error);
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

// ============ QUIZ LEVEL & HISTORY ENDPOINTS ============

// GET learner quiz history (all attempts, newest first)
app.get('/api/learner/quiz-history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, offset = 0, level } = req.query;

    let query = supabase
      .from('quiz_attempts')
      .select('*')
      .eq('user_id', userId)
      .order('attempted_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (level) query = query.eq('quiz_level', Number(level));

    const { data: attempts, error } = await query;

    if (error && error.code !== '42P01') {
      return res.status(400).json({ success: false, error: error.message });
    }

    // Fetch learner's current quiz level
    const { data: learner } = await supabase
      .from('users')
      .select('quiz_level')
      .eq('id', userId)
      .single();

    res.json({
      success: true,
      attempts: attempts || [],
      quiz_level: learner?.quiz_level || 1
    });
  } catch (error) {
    console.error('Quiz history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch quiz history' });
  }
});

// GET learner quiz level info
app.get('/api/learner/quiz-level', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: learner, error } = await supabase
      .from('users')
      .select('quiz_level, username, full_name')
      .eq('id', userId)
      .single();

    if (error) return res.status(400).json({ success: false, error: error.message });

    const currentLevel = learner?.quiz_level || 1;

    // Count attempts per level for stats
    const { data: levelStats } = await supabase
      .from('quiz_attempts')
      .select('quiz_level, passed, score')
      .eq('user_id', userId);

    const levelMap = {};
    (levelStats || []).forEach(a => {
      if (!levelMap[a.quiz_level]) levelMap[a.quiz_level] = { attempts: 0, best_score: 0, passed: false };
      levelMap[a.quiz_level].attempts++;
      if (a.score > levelMap[a.quiz_level].best_score) levelMap[a.quiz_level].best_score = a.score;
      if (a.passed) levelMap[a.quiz_level].passed = true;
    });

    const levels = Array.from({ length: 10 }, (_, i) => ({
      level: i + 1,
      status: i + 1 < currentLevel ? 'completed'
            : i + 1 === currentLevel ? 'current'
            : 'locked',
      attempts: levelMap[i + 1]?.attempts || 0,
      best_score: levelMap[i + 1]?.best_score || 0,
      passed: levelMap[i + 1]?.passed || false
    }));

    res.json({
      success: true,
      current_level: currentLevel,
      is_champion: currentLevel > 10,
      levels
    });
  } catch (error) {
    console.error('Quiz level error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch quiz level' });
  }
});

// POST submit quiz with level tracking (replaces old quiz-submit for level logic)
// We patch the existing submit response to also record to quiz_attempts and handle level advance
app.post('/api/learner/quiz-submit-v2', authenticateToken, async (req, res) => {
  try {
    const { quizId, answers, score, pointsEarned, correctCount, totalQuestions, quizTitle, quizTopic } = req.body;
    const userId = req.user.id;

    if (!quizId || !answers) {
      return res.status(400).json({ error: 'Quiz ID and answers required' });
    }

    // Fetch quiz for metadata
    const { data: quiz } = await supabase
      .from('quizzes')
      .select('id, title, topic, quiz_level, difficulty, class_level')
      .eq('id', quizId)
      .single();

    const quizLevelNum = quiz?.quiz_level || 1;
    const passed = (score || 0) >= 60;

    // Save to quiz_attempts
    const { data: attempt, error: attemptError } = await supabase
      .from('quiz_attempts')
      .insert([{
        user_id: userId,
        quiz_id: quizId,
        quiz_title: quizTitle || quiz?.title || 'Quiz',
        quiz_topic: quizTopic || quiz?.topic || '',
        quiz_level: quizLevelNum,
        score: score || 0,
        correct_count: correctCount || 0,
        total_questions: totalQuestions || answers.length,
        points_earned: passed ? (pointsEarned || 0) : 0,
        passed,
        answers,
        attempted_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (attemptError) {
      console.error('quiz_attempts insert error:', attemptError);
    }

    // Also save to legacy quiz_submissions for compatibility
    await supabase
      .from('quiz_submissions')
      .insert([{
        user_id: userId,
        quiz_id: quizId,
        answers,
        score,
        submitted_at: new Date()
      }])
      .select()
      .single();

    // Award points if passed
    let newCurrentPoints = 0;
    let newLifetimePoints = 0;
    if (passed && pointsEarned > 0) {
      const { data: userData } = await supabase
        .from('users')
        .select('current_points, lifetime_points, quiz_level')
        .eq('id', userId)
        .single();

      newCurrentPoints = (userData?.current_points || 0) + pointsEarned;
      newLifetimePoints = (userData?.lifetime_points || 0) + pointsEarned;

      await supabase
        .from('users')
        .update({ current_points: newCurrentPoints, lifetime_points: newLifetimePoints })
        .eq('id', userId);
    }

    // Level advancement: if passed and quiz is for current level, advance to next
    let levelAdvanced = false;
    let newQuizLevel = null;
    let championBadgeEarned = false;

    const { data: freshUser } = await supabase
      .from('users')
      .select('quiz_level')
      .eq('id', userId)
      .single();

    const userQuizLevel = freshUser?.quiz_level || 1;

    if (passed && quizLevelNum === userQuizLevel && userQuizLevel < 10) {
      const nextLevel = userQuizLevel + 1;
      await supabase
        .from('users')
        .update({ quiz_level: nextLevel })
        .eq('id', userId);
      levelAdvanced = true;
      newQuizLevel = nextLevel;
    } else if (passed && quizLevelNum === userQuizLevel && userQuizLevel === 10) {
      // Reached level 10 — award champion badge
      const nextLevel = 11; // marks champion
      await supabase
        .from('users')
        .update({ quiz_level: nextLevel })
        .eq('id', userId);
      levelAdvanced = true;
      newQuizLevel = 10;

      // Find and award champion badge
      const { data: champBadge } = await supabase
        .from('badges')
        .select('id')
        .eq('name', 'Quiz Champion')
        .single();

      if (champBadge) {
        const { error: badgeErr } = await supabase
          .from('learner_badges')
          .insert([{ learner_id: userId, badge_id: champBadge.id }]);
        if (!badgeErr) championBadgeEarned = true;
      }
    }

    res.json({
      success: true,
      attempt: attempt || null,
      pointsAwarded: passed ? (pointsEarned || 0) : 0,
      passed,
      levelAdvanced,
      newQuizLevel: newQuizLevel || userQuizLevel,
      championBadgeEarned,
      currentQuizLevel: userQuizLevel
    });
  } catch (error) {
    console.error('Quiz submit v2 error:', error);
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

// GET /api/learner/badges  (was missing — needed by LearnerBadges.jsx)
app.get('/api/learner/badges', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('learner_badges')
      .select(`
        id,
        assigned_at,
        badges (
          id, name, description, icon_url, criteria
        )
      `)
      .eq('learner_id', userId)
      .order('assigned_at', { ascending: false });

    if (error) return res.status(400).json({ success: false, error: error.message });

    const badges = (data || []).map(row => ({
      id: row.badges?.id,
      name: row.badges?.name,
      description: row.badges?.description,
      icon_url: row.badges?.icon_url,
      criteria: row.badges?.criteria,
      earned_at: row.assigned_at
    }));

    res.json({ success: true, badges });
  } catch (error) {
    console.error('Learner badges error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch badges' });
  }
});

// ============ CLASS ASSIGNMENT ENDPOINTS ============

app.post('/api/admin/assign-quiz', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📝 Assign quiz request:', req.body);
  
  try {
    const { quizId, classIds } = req.body;

    if (!quizId || !classIds || !Array.isArray(classIds)) {
      return res.status(400).json({ error: 'Quiz ID and class IDs array are required' });
    }

    const { error: deleteError } = await supabase
      .from('class_assignments')
      .delete()
      .eq('quiz_id', quizId);

    if (deleteError) {
      console.error('Error deleting existing assignments:', deleteError);
    }

    const assignments = classIds.map(classId => ({
      quiz_id: parseInt(quizId),
      class_level: classId
    }));

    const { data, error } = await supabase
      .from('class_assignments')
      .insert(assignments)
      .select();

    if (error) {
      console.error('Insert error:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({
      success: true,
      message: `Quiz assigned to ${classIds.length} class(es) successfully`,
      assignments: data
    });

  } catch (error) {
    console.error('Assign quiz error:', error);
    res.status(500).json({ error: 'Failed to assign quiz to classes' });
  }
});

app.get('/api/admin/quiz-classes/:quizId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;

    const { data, error } = await supabase
      .from('class_assignments')
      .select('class_level')
      .eq('quiz_id', quizId);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const assignedClasses = data.map(item => item.class_level);

    res.json({
      success: true,
      classes: assignedClasses
    });

  } catch (error) {
    console.error('Get quiz classes error:', error);
    res.status(500).json({ error: 'Failed to fetch quiz classes' });
  }
});

app.get('/api/admin/quizzes-with-classes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: quizzes, error: quizzesError } = await supabase
      .from('quizzes')
      .select('*')
      .order('created_at', { ascending: false });

    if (quizzesError) {
      return res.status(400).json({ error: quizzesError.message });
    }

    const { data: assignments, error: assignmentsError } = await supabase
      .from('class_assignments')
      .select('*');

    if (assignmentsError) {
      console.error('Error fetching assignments:', assignmentsError);
    }

    const quizClassMap = {};
    if (assignments) {
      assignments.forEach(assignment => {
        if (!quizClassMap[assignment.quiz_id]) {
          quizClassMap[assignment.quiz_id] = [];
        }
        quizClassMap[assignment.quiz_id].push(assignment.class_level);
      });
    }

    const quizzesWithClasses = quizzes.map(quiz => ({
      ...quiz,
      assigned_classes: quizClassMap[quiz.id] || []
    }));

    res.json({
      success: true,
      quizzes: quizzesWithClasses
    });

  } catch (error) {
    console.error('Get quizzes with classes error:', error);
    res.status(500).json({ error: 'Failed to fetch quizzes with class assignments' });
  }
});

// ============ LEARNER MANAGEMENT ENDPOINTS ============

// Get all learners
app.get('/api/admin/learners', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: learners, error } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'learner')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, learners: learners || [] });
  } catch (error) {
    console.error('Get learners error:', error);
    res.status(500).json({ error: 'Failed to fetch learners' });
  }
});

// Register new learner
app.post('/api/admin/learners', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📝 Registering new learner:', { 
    username: req.body.username, 
    full_name: req.body.full_name,
    class_level: req.body.class_level 
  });
  
  try {
    const { username, full_name, registration_number, class_level, district, password } = req.body;

    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }
    if (!registration_number || !registration_number.trim()) {
      return res.status(400).json({ error: 'Registration number is required' });
    }

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('username', username.trim())
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const { data: existingReg } = await supabase
      .from('users')
      .select('id')
      .eq('registration_number', registration_number.trim())
      .maybeSingle();

    if (existingReg) {
      return res.status(400).json({ error: 'Registration number already exists' });
    }

    const defaultPassword = (password && password.trim()) ? password.trim() : registration_number;
    const password_hash = await bcrypt.hash(defaultPassword, 10);

    if (!class_level) {
      return res.status(400).json({ error: 'Class level is required' });
    }

    const assignedClass = class_level;

    const newLearner = {
      username: username.trim(),
      full_name: full_name.trim(),
      registration_number: registration_number.trim(),
      class_level: assignedClass,
      current_level: assignedClass,
      district: district ? district.trim() : null,
      password_hash: password_hash,
      role: 'learner',
      current_points: 0,
      lifetime_points: 0,
      created_at: new Date(),
      updated_at: new Date()
    };

    const { data, error } = await supabase
      .from('users')
      .insert([newLearner])
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log('✅ Learner registered successfully:', data.id);
    
    const { password_hash: _, ...learnerWithoutPassword } = data;

    res.json({ 
      success: true, 
      message: 'Learner registered successfully',
      learner: learnerWithoutPassword,
      default_password: defaultPassword
    });

  } catch (error) {
    console.error('Register learner error:', error);
    res.status(500).json({ error: 'Failed to register learner: ' + error.message });
  }
});

// Update learner's class level
app.put('/api/admin/learners/:learnerId/class', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;
    const { class_level } = req.body;

    if (!class_level) {
      return res.status(400).json({ error: 'Class level is required' });
    }

    if (!ALL_LEVELS.includes(class_level)) {
      return res.status(400).json({ error: 'Invalid class level' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ 
        class_level: class_level, 
        current_level: class_level,
        updated_at: new Date() 
      })
      .eq('id', learnerId)
      .eq('role', 'learner')
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: 'Class level updated successfully', learner: data });
  } catch (error) {
    console.error('Update learner class error:', error);
    res.status(500).json({ error: 'Failed to update learner class' });
  }
});

// Update learner's current level
app.put('/api/admin/learners/:learnerId/current-level', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;
    const { current_level } = req.body;

    if (!current_level) {
      return res.status(400).json({ error: 'Current level is required' });
    }

    if (!ALL_LEVELS.includes(current_level)) {
      return res.status(400).json({ error: 'Invalid level' });
    }

    const { data: learner, error: fetchError } = await supabase
      .from('users')
      .select('class_level')
      .eq('id', learnerId)
      .eq('role', 'learner')
      .single();

    if (fetchError) {
      return res.status(404).json({ error: 'Learner not found' });
    }

    const classIndex = ALL_LEVELS.indexOf(learner.class_level);
    const currentIndex = ALL_LEVELS.indexOf(current_level);

    if (currentIndex > classIndex) {
      return res.status(400).json({ 
        error: `Cannot set current level (${current_level}) above class level (${learner.class_level})`,
        max_allowed: learner.class_level
      });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ current_level: current_level, updated_at: new Date() })
      .eq('id', learnerId)
      .eq('role', 'learner')
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: 'Current level updated successfully', learner: data });
  } catch (error) {
    console.error('Update learner current level error:', error);
    res.status(500).json({ error: 'Failed to update learner current level' });
  }
});

// ============ ADMIN QUIZ ENDPOINTS ============

app.get('/api/admin/quizzes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: quizzes, error } = await supabase
      .from('quizzes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, quizzes: quizzes || [] });
  } catch (error) {
    console.error('Get admin quizzes error:', error);
    res.status(500).json({ error: 'Failed to fetch quizzes' });
  }
});

// Create quiz
app.post('/api/admin/quizzes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { 
      title, topic, description, questions, start_time, end_time, 
      is_active, image_url, difficulty, 
      random_selection = false, 
      questions_per_attempt = 20,
      class_level
    } = req.body;

    if (!title || !topic || !questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Title, topic, and questions array are required' });
    }

    const newQuiz = {
      title: title.trim(),
      topic: topic.trim(),
      description: description?.trim() || '',
      questions,
      start_time: start_time || null,
      end_time: end_time || null,
      is_active: is_active !== false,
      image_url: image_url?.trim() || null,
      difficulty: difficulty || 'intermediate',
      random_selection: random_selection,
      questions_per_attempt: questions_per_attempt,
      class_level: class_level || null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const { data, error } = await supabase
      .from('quizzes')
      .insert([newQuiz])
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, quiz: data });
  } catch (error) {
    console.error('Create quiz error:', error);
    res.status(500).json({ error: 'Failed to create quiz' });
  }
});

// Update quiz
app.put('/api/admin/quizzes/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      title, topic, description, questions, start_time, end_time, 
      is_active, image_url, difficulty,
      random_selection, questions_per_attempt,
      class_level
    } = req.body;

    const updates = {
      title: title?.trim(),
      topic: topic?.trim(),
      description: description?.trim(),
      questions,
      start_time: start_time || null,
      end_time: end_time || null,
      is_active: is_active !== false,
      image_url: image_url?.trim() || null,
      difficulty: difficulty || 'intermediate',
      random_selection: random_selection,
      questions_per_attempt: questions_per_attempt,
      class_level: class_level || null,
      updated_at: new Date()
    };

    const { data, error } = await supabase
      .from('quizzes')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, quiz: data });
  } catch (error) {
    console.error('Update quiz error:', error);
    res.status(500).json({ error: 'Failed to update quiz' });
  }
});

// Delete quiz
app.delete('/api/admin/quizzes/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error: assignmentError } = await supabase
      .from('class_assignments')
      .delete()
      .eq('quiz_id', id);
    
    if (assignmentError) {
      console.error('Error deleting class assignments:', assignmentError);
    }
    
    const { error: submissionsError } = await supabase
      .from('quiz_submissions')
      .delete()
      .eq('quiz_id', id);
    
    if (submissionsError) {
      console.error('Error deleting submissions:', submissionsError);
    }
    
    const { error } = await supabase
      .from('quizzes')
      .delete()
      .eq('id', id);
    
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    
    res.json({ success: true, message: 'Quiz deleted successfully' });
  } catch (error) {
    console.error('Delete quiz error:', error);
    res.status(500).json({ error: 'Failed to delete quiz' });
  }
});

// ============ ADMIN BADGES ENDPOINTS ============

// Get all badges
app.get('/api/admin/badges', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: badges, error } = await supabase
      .from('badges')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching badges:', error);
      return res.status(400).json({ success: false, message: 'Failed to fetch badges' });
    }

    res.json({ success: true, badges: badges || [] });
  } catch (error) {
    console.error('Fetch badges error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch badges' });
  }
});

// Create badge
app.post('/api/admin/badges', authenticateToken, requireAdmin, async (req, res) => {
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

    if (!name) {
      return res.status(400).json({ success: false, message: 'Badge name is required' });
    }

    const { data: existingBadge } = await supabase
      .from('badges')
      .select('id')
      .eq('name', name.trim())
      .single();

    if (existingBadge) {
      return res.status(400).json({ success: false, message: 'A badge with this name already exists' });
    }

    const { data: badge, error } = await supabase
      .from('badges')
      .insert([{
        name: name.trim(),
        description: description || 'No description provided',
        icon_url: icon_url || '',
        criteria: criteria || 'Complete the required actions to earn this badge',
        is_active: is_active !== undefined ? is_active : true,
        automation_enabled: automation_enabled || false,
        automation_trigger: automation_trigger || '',
        automation_condition: automation_condition || 'greater_equal',
        automation_threshold: automation_threshold || 0,
        automation_points_reward: automation_points_reward || 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      console.error('Error creating badge:', error);
      return res.status(400).json({ success: false, message: 'Failed to create badge' });
    }

    res.status(201).json({ success: true, badge });
  } catch (error) {
    console.error('Create badge error:', error);
    res.status(500).json({ success: false, message: 'Failed to create badge' });
  }
});

// Update badge
app.put('/api/admin/badges/:id', authenticateToken, requireAdmin, async (req, res) => {
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

    const { data: existingBadge } = await supabase
      .from('badges')
      .select('*')
      .eq('id', id)
      .single();

    if (!existingBadge) {
      return res.status(404).json({ success: false, message: 'Badge not found' });
    }

    if (name && name.trim() !== existingBadge.name) {
      const { data: duplicate } = await supabase
        .from('badges')
        .select('id')
        .eq('name', name.trim())
        .single();

      if (duplicate) {
        return res.status(400).json({ success: false, message: 'A badge with this name already exists' });
      }
    }

    const { data: badge, error } = await supabase
      .from('badges')
      .update({
        name: name ? name.trim() : existingBadge.name,
        description: description !== undefined ? description : existingBadge.description,
        icon_url: icon_url !== undefined ? icon_url : existingBadge.icon_url,
        criteria: criteria !== undefined ? criteria : existingBadge.criteria,
        is_active: is_active !== undefined ? is_active : existingBadge.is_active,
        automation_enabled: automation_enabled !== undefined ? automation_enabled : existingBadge.automation_enabled,
        automation_trigger: automation_trigger !== undefined ? automation_trigger : existingBadge.automation_trigger,
        automation_condition: automation_condition !== undefined ? automation_condition : existingBadge.automation_condition,
        automation_threshold: automation_threshold !== undefined ? automation_threshold : existingBadge.automation_threshold,
        automation_points_reward: automation_points_reward !== undefined ? automation_points_reward : existingBadge.automation_points_reward,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating badge:', error);
      return res.status(400).json({ success: false, message: 'Failed to update badge' });
    }

    res.json({ success: true, badge });
  } catch (error) {
    console.error('Update badge error:', error);
    res.status(500).json({ success: false, message: 'Failed to update badge' });
  }
});

// Delete badge
app.delete('/api/admin/badges/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: badge, error } = await supabase
      .from('badges')
      .delete()
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error deleting badge:', error);
      return res.status(404).json({ success: false, message: 'Badge not found' });
    }

    res.json({ success: true, message: 'Badge deleted successfully' });
  } catch (error) {
    console.error('Delete badge error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete badge' });
  }
});

// Assign badge to learner
app.post('/api/admin/badges/assign', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { badgeId, learnerId } = req.body;

    if (!badgeId || !learnerId) {
      return res.status(400).json({ success: false, message: 'Badge ID and Learner ID are required' });
    }

    const { data: badge } = await supabase
      .from('badges')
      .select('id')
      .eq('id', badgeId)
      .single();

    if (!badge) {
      return res.status(404).json({ success: false, message: 'Badge not found' });
    }

    const { data: learner } = await supabase
      .from('users')
      .select('id')
      .eq('id', learnerId)
      .eq('role', 'learner')
      .single();

    if (!learner) {
      return res.status(404).json({ success: false, message: 'Learner not found' });
    }

    const { data: existingAssignment } = await supabase
      .from('learner_badges')
      .select('id')
      .eq('learner_id', learnerId)
      .eq('badge_id', badgeId)
      .single();

    if (existingAssignment) {
      return res.status(400).json({ success: false, message: 'Learner already has this badge' });
    }

    const { error } = await supabase
      .from('learner_badges')
      .insert([{
        learner_id: learnerId,
        badge_id: badgeId,
        assigned_at: new Date().toISOString()
      }]);

    if (error) {
      console.error('Error assigning badge:', error);
      return res.status(400).json({ success: false, message: 'Failed to assign badge' });
    }

    res.json({ success: true, message: 'Badge assigned successfully' });
  } catch (error) {
    console.error('Assign badge error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign badge' });
  }
});

// ============ APPEARANCE SETTINGS ============

// GET appearance settings (public for learners — no auth required)
app.get('/api/appearance-settings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'appearance')
      .single();

    if (error || !data) {
      // Return defaults if not yet configured
      return res.json({
        success: true,
        settings: {
          fontFamily: 'Inter',
          fontSize: '16',
          headingSize: '24',
          bodyColor: '#1f2937',
          headingColor: '#0f766e',
          linkColor: '#0d9488',
          bgColor: '#f0fdfa',
          borderRadius: '12'
        }
      });
    }

    res.json({ success: true, settings: data.value });
  } catch (error) {
    console.error('Get appearance settings error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

// GET appearance settings (admin — same data, just separate route for clarity)
app.get('/api/admin/appearance-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('*')
      .eq('key', 'appearance')
      .single();

    if (error || !data) {
      return res.json({
        success: true,
        settings: {
          fontFamily: 'Inter',
          fontSize: '16',
          headingSize: '24',
          bodyColor: '#1f2937',
          headingColor: '#0f766e',
          linkColor: '#0d9488',
          bgColor: '#f0fdfa',
          borderRadius: '12'
        }
      });
    }

    res.json({ success: true, settings: data.value, updated_at: data.updated_at });
  } catch (error) {
    console.error('Admin get appearance settings error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

// PUT update appearance settings (admin only)
app.put('/api/admin/appearance-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ success: false, error: 'Settings object is required' });
    }

    // Try to update existing row first
    const { data: existing } = await supabase
      .from('app_settings')
      .select('id')
      .eq('key', 'appearance')
      .single();

    let data, error;

    if (existing) {
      // Update existing
      ({ data, error } = await supabase
        .from('app_settings')
        .update({
          value: settings,
          updated_at: new Date().toISOString()
        })
        .eq('key', 'appearance')
        .select()
        .single());
    } else {
      // Insert new
      ({ data, error } = await supabase
        .from('app_settings')
        .insert({
          key: 'appearance',
          value: settings,
          updated_at: new Date().toISOString()
        })
        .select()
        .single());
    }

    if (error) {
      console.error('Update appearance error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, settings: data.value, message: 'Settings saved successfully' });
  } catch (error) {
    console.error('Update appearance settings error:', error);
    res.status(500).json({ success: false, error: 'Failed to save settings' });
  }
});

// ============ SUBJECTS AND DIFFICULTIES ENDPOINTS ============

app.get('/api/subjects', authenticateToken, async (req, res) => {
  try {
    const subjects = [
      { subject_id: 'mathematics', name: 'Mathematics', icon: '🔢', color: 'blue' },
      { subject_id: 'english', name: 'English', icon: '📖', color: 'green' },
      { subject_id: 'primary-science', name: 'Science', icon: '🔬', color: 'purple' },
      { subject_id: 'social-studies', name: 'Social Studies', icon: '🌍', color: 'orange' },
      { subject_id: 'bible-knowledge', name: 'Bible Knowledge', icon: '📖', color: 'yellow' },
      { subject_id: 'arts-life-skills', name: 'Arts & Life Skills', icon: '🎨', color: 'pink' },
      { subject_id: 'chichewa', name: 'Chichewa', icon: '🇲🇼', color: 'red' }
    ];
    
    res.json({ success: true, subjects });
  } catch (error) {
    console.error('Error fetching subjects:', error);
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

app.get('/api/difficulty-levels', authenticateToken, async (req, res) => {
  try {
    const difficulties = [
      { id: 'beginner', name: 'Beginner', icon: '🌱', points: 1, timeLimit: 45 },
      { id: 'easy', name: 'Easy', icon: '📘', points: 2, timeLimit: 35 },
      { id: 'medium', name: 'Medium', icon: '📚', points: 3, timeLimit: 30 },
      { id: 'hard', name: 'Hard', icon: '🎓', points: 4, timeLimit: 25 },
      { id: 'expert', name: 'Expert', icon: '🏆', points: 5, timeLimit: 20 }
    ];
    
    res.json({ success: true, difficulties });
  } catch (error) {
    console.error('Error fetching difficulties:', error);
    res.status(500).json({ error: 'Failed to fetch difficulty levels' });
  }
});

// ============ THEME SETTINGS ============

// GET theme settings (admin)
app.get('/api/admin/theme-settings', authenticateToken, async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'theme')
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(400).json({ success: false, error: error.message });
    }

    const defaultSettings = {
      theme: 'ocean',
      darkMode: false,
    };

    res.json({
      success: true,
      settings: settings?.value || defaultSettings,
    });
  } catch (error) {
    console.error('Get theme settings error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch theme settings' });
  }
});

// POST/UPDATE theme settings (admin)
app.post('/api/admin/theme-settings', authenticateToken, async (req, res) => {
  try {
    const { theme, darkMode } = req.body;

    // Validate theme
    const validThemes = ['ocean', 'royal', 'sunset'];
    if (!validThemes.includes(theme)) {
      return res.status(400).json({ success: false, error: 'Invalid theme' });
    }

    const settings = { theme, darkMode: darkMode || false };

    // Theme color mappings that apply to learner pages
    const themeColors = {
      ocean: {
        headingColor: '#0f766e',
        linkColor: '#0d9488',
        bgColor: '#f0fdfa',
        accentColor: '#14b8a6',
        headerBg: '#19475F',
        navbarBg: '#005F73',
        containerBg: '#ffffff',
        containerBorder: '#e2e8f0',
      },
      royal: {
        headingColor: '#6d28d9',
        linkColor: '#7c3aed',
        bgColor: '#f5f3ff',
        accentColor: '#8b5cf6',
        headerBg: '#3b1f7e',
        navbarBg: '#4c1d95',
        containerBg: '#ffffff',
        containerBorder: '#e9d5ff',
      },
      sunset: {
        headingColor: '#d97706',
        linkColor: '#f59e0b',
        bgColor: '#fffbeb',
        accentColor: '#fbbf24',
        headerBg: '#7c2d12',
        navbarBg: '#9a3412',
        containerBg: '#ffffff',
        containerBorder: '#fed7aa',
      }
    };

    // Save theme setting
    const { data: existing, error: checkError } = await supabase
      .from('app_settings')
      .select('id')
      .eq('key', 'theme')
      .maybeSingle();

    let data, error;

    if (existing) {
      ({ data, error } = await supabase
        .from('app_settings')
        .update({
          value: settings,
          updated_at: new Date().toISOString()
        })
        .eq('key', 'theme')
        .select()
        .single());
    } else {
      ({ data, error } = await supabase
        .from('app_settings')
        .insert({
          key: 'theme',
          value: settings,
          updated_at: new Date().toISOString()
        })
        .select()
        .single());
    }

    if (error) {
      console.error('Theme settings save error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    // Also update the appearance settings so learner pages pick up the theme colors
    const colors = themeColors[theme];
    if (colors) {
      const { data: appearanceRow } = await supabase
        .from('app_settings')
        .select('id, value')
        .eq('key', 'appearance')
        .maybeSingle();

      if (appearanceRow) {
        // Merge theme colors into existing appearance settings
        const updatedAppearance = {
          ...appearanceRow.value,
          headingColor: colors.headingColor,
          linkColor: colors.linkColor,
          bgColor: colors.bgColor,
          accentColor: colors.accentColor,
          headerBg: colors.headerBg,
          navbarBg: colors.navbarBg,
          containerBg: colors.containerBg,
          containerBorder: colors.containerBorder,
        };

        await supabase
          .from('app_settings')
          .update({
            value: updatedAppearance,
            updated_at: new Date().toISOString()
          })
          .eq('key', 'appearance');
      } else {
        // Create appearance settings with theme colors
        await supabase
          .from('app_settings')
          .insert({
            key: 'appearance',
            value: {
              fontFamily: 'Inter',
              fontSize: '16',
              headingSize: '24',
              bodyColor: '#1f2937',
              headingColor: colors.headingColor,
              linkColor: colors.linkColor,
              bgColor: colors.bgColor,
              accentColor: colors.accentColor,
              headerBg: colors.headerBg,
              navbarBg: colors.navbarBg,
              containerBg: colors.containerBg,
              containerBorder: colors.containerBorder,
              cardBg: '#ffffff',
              borderRadius: '12',
            },
            updated_at: new Date().toISOString()
          });
      }
    }

    res.json({
      success: true,
      settings: data.value,
      message: 'Theme settings saved successfully',
    });
  } catch (error) {
    console.error('Save theme settings error:', error);
    res.status(500).json({ success: false, error: 'Failed to save theme settings: ' + error.message });
  }
});

// GET theme settings (public - no auth required)
app.get('/api/theme-settings', async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'theme')
      .maybeSingle();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const defaultSettings = {
      theme: 'ocean',
      darkMode: false,
    };

    res.json({
      success: true,
      settings: settings?.value || defaultSettings,
    });
  } catch (error) {
    console.error('Get public theme settings error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch theme settings' });
  }
});

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 5000;

(async () => {
  try {
    const dns = require('dns').promises;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!supabaseUrl) {
      console.error('❌ SUPABASE_URL is not set in .env');
      process.exit(1);
    }

    let hostname;
    try {
      hostname = new URL(supabaseUrl).hostname;
    } catch (err) {
      console.error('❌ SUPABASE_URL is invalid:', supabaseUrl);
      process.exit(1);
    }

    try {
      await dns.lookup(hostname);
      console.log(`✅ DNS lookup successful for ${hostname}`);
    } catch (err) {
      console.error(`❌ DNS lookup failed for ${hostname}:`, err.message || err);
      process.exit(1);
    }

    // Initialize Supabase
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
    );
    console.log('✅ Supabase client initialized');

    // Initialize RAG clients
    await initRAGClients();

    // ============ REGISTER SETTINGS ROUTE ============
    // This must be registered AFTER supabase is initialized
    const adminSettingsRoutes = require('./routes/admin/settings');
    app.use('/api/admin', adminSettingsRoutes);
    console.log('✅ Settings route registered');

    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
      console.log(`📚 RAG endpoints: http://localhost:${PORT}/api/admin/rag/*`);
      console.log(`🎁 Rewards endpoints: http://localhost:${PORT}/api/admin/rewards`);
      console.log(`🕹️ HANGMAN: /api/admin/hangman/*`);
      console.log(`🔤 SPELLING BEE: /api/spelling/*`);
      console.log(`📝 QUIZZES: /api/admin/quizzes`);
      console.log(`👥 LEARNERS: /api/admin/learners`);
      console.log(`🏅 BADGES: /api/admin/badges`);
      console.log(`🎨 APPEARANCE: /api/admin/settings`);
    });

  } catch (err) {
    console.error('Server startup error:', err);
    process.exit(1);
  }
})();