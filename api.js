const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const { ObjectId } = require('mongoose').Types;
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app); 
const io = new Server(server); 

app.use(bodyParser.json());
app.use(express.static('public'));

// Get OpenAI key
const { OpenAI } = require('openai');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, 
});

// Connect to MongoDB
mongoose
  .connect('mongodb://127.0.0.1:27017/ChatGPT_Evaluation')
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Define the accuracy schema and model
const AccuracySchema = new mongoose.Schema({
  questionCollection: String,
  times_correct: { type: Number, default: 0 },
  times_incorrect: { type: Number, default: 0 },
  total_times: { type: Number, default: 0 },
  total_response_time: { type: Number, default: 0 }, 
  avg_response_time: { type: Number, default: 0 }
});

const Accuracy = mongoose.model('Accuracy', AccuracySchema, 'Accuracy');

// Route to serve index.html 
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Define the models for each collection
const createSchema = (collectionName) => {
  const baseSchema = {
    questionText: String,
    A: String,
    B: String,
    C: String,
    D: String,
    groundTruth: String,
    chatgptResponse: String,
  };
  return mongoose.model(collectionName, new mongoose.Schema(baseSchema, { collection: collectionName }));
};

const models = {
  CS: createSchema('Computer_Security'),
  Hist: createSchema('History'),
  SS: createSchema('Social_Science'),
};

// Routing to ask-chatgpt
app.get('/ask-chatgpt', async (req, res) => {
  const param = req.query.param; 
  const Question = models[param];
  if (!Question) {
    return res.status(400).send('Invalid parameter');
  }

  try {
    const question = await Question.aggregate([{ $sample: { size: 1 } }]);
    if (!question || question.length === 0) {
      return res.status(404).send('No questions found');
    }

    const randomQuestion = question[0];
    console.log('Random Question:', randomQuestion);

    const prompt = `
      Question: ${randomQuestion.questionText}
      Options:
      A: ${randomQuestion.A}
      B: ${randomQuestion.B}
      C: ${randomQuestion.C}
      D: ${randomQuestion.D}
      Please respond with ONLY the letters A, B, C, or D.
    `;
    console.log('Prompt sent to ChatGPT:', prompt);

    try {
      const startTime = Date.now(); 
    
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: prompt },
        ],
      });
    
      const endTime = Date.now(); 
      const responseTime = endTime - startTime; 
    
      console.log('OpenAI Response:', response);
    
      let chatgptResponse = response.choices && response.choices[0]?.message.content.trim();
      if (!chatgptResponse) {
        throw new Error('No valid response from OpenAI');
      }
    
      const match = chatgptResponse.match(/([A-D])/i);
      if (match) {
        chatgptResponse = match[0];
      } else {
        throw new Error('Invalid response format');
      }
    
      randomQuestion.chatgptResponse = chatgptResponse;
      await Question.findByIdAndUpdate(randomQuestion._id, { chatgptResponse });
    
      console.log('Question updated with response:', chatgptResponse);
    
      const isCorrect = chatgptResponse === randomQuestion.groundTruth;
    
      const accuracyDoc = await Accuracy.findOne({ questionCollection: param });
    
      const newTotalTimes = accuracyDoc ? accuracyDoc.total_times + 1 : 1;
      const newTotalResponseTime = accuracyDoc ? accuracyDoc.total_response_time + responseTime : responseTime;
      const newAvgResponseTime = newTotalResponseTime / newTotalTimes;
    
      const updateFields = {
        $inc: {
          times_correct: isCorrect ? 1 : 0,
          times_incorrect: isCorrect ? 0 : 1,
          total_times: 1,
        },
        $set: {
          total_response_time: newTotalResponseTime,
          avg_response_time: newAvgResponseTime,
        },
      };
    
      // Update or create the accuracy document
      const updatedAccuracyDoc = await Accuracy.findOneAndUpdate(
        { questionCollection: param },
        updateFields,
        { new: true, upsert: true }
      );
    
      console.log('Accuracy updated:', updatedAccuracyDoc);
    
      res.json({
        message: 'ChatGPT response saved successfully',
        question: randomQuestion,
        responseTime,
      });
    } catch (openaiError) {
      console.error('OpenAI API Error:', openaiError.response?.data || openaiError.message);
      res.status(500).send('Failed to get response from OpenAI');
    }
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('An error occurred');
  }
});

// Endpoint to get data
app.get('/data', async (req, res) => {
  try {
    const data = await Accuracy.find();
    res.json(data);
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).send('Error fetching data from MongoDB');
  }
});

// WebSocket event for real-time updates
io.on('connection', (socket) => {
  socket.on('updateChart', async () => {
    const data = await Accuracy.find();
    socket.emit('chartData', data);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start the server
server.listen(3000, () => {
  console.log('Server is running on http://localhost:3000');
});
