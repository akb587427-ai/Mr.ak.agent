// Loads every module so a missing import or a syntax error is caught here rather than
// at the moment a customer writes in. server.js is skipped because importing it starts
// the web server.
import './agent.js';
import './calls.js';
import './knowledge.js';
import './llm.js';
import './store.js';
import './tools.js';
import './voice.js';
import './whatsapp.js';

console.log('all modules load');
