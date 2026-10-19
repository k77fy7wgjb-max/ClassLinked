const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

// Read settings from a .env file if there is one (so you don't need extra tools).
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase().replace(/^@/, '');
const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// Video calls connect every person to every other person, so big calls get heavy.
const MAX_CALL_SIZE = Number(process.env.MAX_CALL_SIZE) || 10;
const MAX_MESSAGES_PER_CHAT = 500;

if (!DOMAIN) {
  console.error('Set ALLOWED_EMAIL_DOMAIN to your school email domain (see .env.example).');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.warn('No SESSION_SECRET set, so everyone gets logged out when the server restarts.');
}

// STUN helps browsers find each other. TURN relays the call when a network
// blocks direct connections (common on school Wi-Fi).
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL.split(',').map((u) => u.trim()),
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL,
  });
}

// --- Saved data, stored in simple JSON files ---
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

function load(name, fallback) {
  const file = path.join(dataDir, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}
const saveTimers = {};
function save(name, value) {
  // Wait a moment so lots of messages in a row only write the file once.
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
  }, 200);
}

let users = load('users.json', []);
let classes = load('classes.json', []); // { id, name, ownerId, memberIds }
let messages = load('messages.json', {}); // chatId -> [{ id, from, text, at }]
let contacts = load('contacts.json', {}); // userId -> { otherUserId: name they saved }

// Every student gets a 7 digit Classlinked number, like 482-1937.
const digitsOnly = (s) => String(s || '').replace(/\D/g, '');
function newNumber() {
  let n;
  do n = String(1000000 + crypto.randomInt(9000000));
  while (users.some((u) => u.number === n));
  return n;
}
const formatNumber = (n) => `${n.slice(0, 3)}-${n.slice(3)}`;
for (const u of users) if (!u.number) u.number = newNumber();
save('users.json', users);

const userById = (id) => users.find((u) => u.id === id);
const userByNumber = (num) => users.find((u) => u.number === digitsOnly(num));
const publicUser = (u) => ({ id: u.id, name: u.name, number: formatNumber(u.number) });
// The name someone saved for a contact, or the name that person signed up with.
const nameFor = (viewerId, u) => contacts[viewerId]?.[u.id] || u.name;

// --- Web server ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 },
});

app.set('trust proxy', 1);
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => res.json({ domain: DOMAIN, iceServers, maxCallSize: MAX_CALL_SIZE }));

app.post('/api/signup', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!name || name.length > 40) return res.status(400).json({ error: 'Enter a name (up to 40 characters).' });
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.split('@')[1] !== DOMAIN) {
    return res.status(400).json({ error: `Use your @${DOMAIN} school email.` });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (users.some((u) => u.email === email)) return res.status(400).json({ error: 'That email already has an account.' });

  const user = { id: crypto.randomUUID(), name, email, number: newNumber(), passwordHash: await bcrypt.hash(password, 10) };
  users.push(user);
  save('users.json', users);
  req.session.userId = user.id;
  res.json(publicUser(user));
});

app.post('/api/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = users.find((u) => u.email === email);
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.passwordHash))) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  req.session.userId = user.id;
  res.json(publicUser(user));
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  const user = userById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json(publicUser(user));
});

// --- Chats ---
// A chat is either a one-on-one ("dm:<idA>:<idB>") or a class ("class:<id>").
const dmId = (a, b) => 'dm:' + [a, b].sort().join(':');

function chatMembers(chatId) {
  if (chatId.startsWith('dm:')) {
    const ids = chatId.split(':').slice(1);
    return ids.length === 2 && ids.every(userById) ? ids : null;
  }
  const c = classes.find((x) => 'class:' + x.id === chatId);
  return c ? c.memberIds : null;
}
function isMember(userId, chatId) {
  const m = chatMembers(chatId);
  return !!m && m.includes(userId);
}
function chatSummary(chatId, forUserId) {
  const memberIds = chatMembers(chatId);
  const list = messages[chatId] || [];
  const base = {
    id: chatId,
    members: memberIds.map((id) => {
      const u = userById(id);
      return { ...publicUser(u), name: nameFor(forUserId, u), online: isOnline(id) };
    }),
    last: list[list.length - 1] || null,
    call: callParticipants(chatId),
  };
  if (chatId.startsWith('dm:')) {
    const other = userById(memberIds.find((id) => id !== forUserId));
    return { ...base, type: 'dm', name: nameFor(forUserId, other), subtitle: formatNumber(other.number) };
  }
  const c = classes.find((x) => 'class:' + x.id === chatId);
  return { ...base, type: 'class', name: c.name, subtitle: `${memberIds.length} people`, ownerId: c.ownerId };
}
function chatsFor(userId) {
  const ids = new Set(Object.keys(messages).filter((id) => id.startsWith('dm:') && isMember(userId, id)));
  for (const c of classes) if (c.memberIds.includes(userId)) ids.add('class:' + c.id);
  return [...ids].map((id) => chatSummary(id, userId));
}
function pushChat(chatId) {
  for (const id of chatMembers(chatId) || []) io.to('user:' + id).emit('chat', chatSummary(chatId, id));
}

// Turn "482-1937, 555 0000" into users. Returns { found, missing }.
function lookupNumbers(input) {
  const parts = (Array.isArray(input) ? input : String(input || '').split(/[,;\n]+/)).map(digitsOnly).filter(Boolean);
  const found = [];
  const missing = [];
  for (const p of parts) {
    const u = userByNumber(p);
    if (u) found.push(u);
    else missing.push(p.length === 7 ? formatNumber(p) : p);
  }
  return { found, missing };
}

// --- Live presence, texting and calls ---
io.engine.use(sessionMiddleware);

const onlineCount = new Map(); // userId -> number of open tabs
const calls = new Map(); // chatId -> Map(userId -> socketId)
const userCall = new Map(); // userId -> chatId of the call they're in

const isOnline = (id) => (onlineCount.get(id) || 0) > 0;
function callParticipants(chatId) {
  return [...(calls.get(chatId)?.keys() || [])];
}
function contactsOf(userId) {
  const ids = new Set();
  for (const chat of chatsFor(userId)) for (const m of chat.members) ids.add(m.id);
  ids.delete(userId);
  return ids;
}
function broadcastPresence(userId) {
  const payload = { id: userId, online: isOnline(userId) };
  for (const id of contactsOf(userId)) io.to('user:' + id).emit('presence', payload);
}

function leaveCall(userId) {
  const chatId = userCall.get(userId);
  if (!chatId) return;
  const room = calls.get(chatId);
  userCall.delete(userId);
  room.delete(userId);
  for (const sid of room.values()) io.to(sid).emit('call:peer-left', { chatId, peerId: userId });
  if (room.size === 0) calls.delete(chatId);
  pushChat(chatId);
}

io.use((socket, next) => {
  const user = userById(socket.request.session?.userId);
  if (!user) return next(new Error('not logged in'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const me = socket.data.user;
  socket.join('user:' + me.id);
  onlineCount.set(me.id, (onlineCount.get(me.id) || 0) + 1);
  socket.emit('chats', chatsFor(me.id));
  broadcastPresence(me.id);

  socket.on('chat:history', (chatId, reply) => {
    if (typeof reply !== 'function' || !isMember(me.id, chatId)) return;
    reply(messages[chatId] || []);
  });

  // Add button, step 1: check the number belongs to someone.
  socket.on('contact:check', (number, reply) => {
    if (typeof reply !== 'function') return;
    const other = userByNumber(number);
    if (!other) return reply({ error: 'No one has that number.' });
    if (other.id === me.id) return reply({ error: "That's your own number." });
    reply({ ok: true, number: formatNumber(other.number) });
  });

  // Add button, step 2: save them with a name. If you're in a class, they join it too.
  socket.on('contact:save', ({ number, name, classChatId } = {}, reply) => {
    if (typeof reply !== 'function') return;
    const other = userByNumber(number);
    name = String(name || '').trim();
    if (!other || other.id === me.id) return reply({ error: 'No one has that number.' });
    if (!name || name.length > 40) return reply({ error: 'Enter a name (up to 40 characters).' });
    (contacts[me.id] ||= {})[other.id] = name;
    save('contacts.json', contacts);
    for (const chat of chatsFor(me.id)) {
      if (chat.members.some((m) => m.id === other.id)) socket.emit('chat', chatSummary(chat.id, me.id));
    }
    const c = classes.find((x) => 'class:' + x.id === classChatId);
    if (c && c.memberIds.includes(me.id)) {
      if (!c.memberIds.includes(other.id)) c.memberIds.push(other.id);
      save('classes.json', classes);
      pushChat(classChatId);
      return reply({ chat: chatSummary(classChatId, me.id) });
    }
    reply({ chat: chatSummary(dmId(me.id, other.id), me.id) });
  });

  // Start a one-on-one chat with someone's number.
  socket.on('dm:start', (number, reply) => {
    if (typeof reply !== 'function') return;
    const other = userByNumber(number);
    if (!other) return reply({ error: 'No one has that number.' });
    if (other.id === me.id) return reply({ error: "That's your own number." });
    const chatId = dmId(me.id, other.id);
    reply({ chat: chatSummary(chatId, me.id) });
  });

  // Make a class from a name and a list of numbers.
  socket.on('class:create', ({ name, numbers } = {}, reply) => {
    if (typeof reply !== 'function') return;
    name = String(name || '').trim();
    if (!name || name.length > 40) return reply({ error: 'Give the class a name (up to 40 characters).' });
    const { found, missing } = lookupNumbers(numbers);
    if (missing.length) return reply({ error: `No one has: ${missing.join(', ')}` });
    const memberIds = [...new Set([me.id, ...found.map((u) => u.id)])];
    if (memberIds.length < 2) return reply({ error: 'Add at least one other number.' });
    const c = { id: crypto.randomUUID(), name, ownerId: me.id, memberIds };
    classes.push(c);
    save('classes.json', classes);
    pushChat('class:' + c.id);
    reply({ chat: chatSummary('class:' + c.id, me.id) });
  });

  // Anyone in a class can add more numbers.
  socket.on('class:add', ({ chatId, numbers } = {}, reply) => {
    if (typeof reply !== 'function') return;
    const c = classes.find((x) => 'class:' + x.id === chatId);
    if (!c || !c.memberIds.includes(me.id)) return reply({ error: "You're not in this class." });
    const { found, missing } = lookupNumbers(numbers);
    if (missing.length) return reply({ error: `No one has: ${missing.join(', ')}` });
    for (const u of found) if (!c.memberIds.includes(u.id)) c.memberIds.push(u.id);
    save('classes.json', classes);
    pushChat(chatId);
    reply({ ok: true });
  });

  socket.on('class:leave', (chatId) => {
    const c = classes.find((x) => 'class:' + x.id === chatId);
    if (!c || !c.memberIds.includes(me.id)) return;
    if (userCall.get(me.id) === chatId) leaveCall(me.id);
    c.memberIds = c.memberIds.filter((id) => id !== me.id);
    if (c.ownerId === me.id) c.ownerId = c.memberIds[0];
    if (c.memberIds.length === 0) {
      classes = classes.filter((x) => x !== c);
      delete messages[chatId];
      save('messages.json', messages);
    }
    save('classes.json', classes);
    socket.emit('chat:removed', chatId);
    if (c.memberIds.length) pushChat(chatId);
  });

  socket.on('msg:send', ({ chatId, text } = {}) => {
    text = String(text || '').trim().slice(0, 1000);
    if (!text || !isMember(me.id, chatId)) return;
    const msg = { id: crypto.randomUUID(), chatId, from: me.id, fromName: me.name, text, at: Date.now() };
    const list = (messages[chatId] ||= []);
    list.push(msg);
    if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
    save('messages.json', messages);
    for (const id of chatMembers(chatId)) io.to('user:' + id).emit('msg', msg);
    if (list.length === 1) pushChat(chatId); // a brand new one-on-one shows up for the other person
  });

  // --- Calls ---
  // Start or join the call for a chat. Everyone in the call connects to everyone else.
  // Calls are video only, with no sound.
  socket.on('call:join', ({ chatId } = {}, reply) => {
    if (typeof reply !== 'function' || !isMember(me.id, chatId)) return;
    if (userCall.has(me.id)) return reply({ error: "You're already in a call." });
    const room = calls.get(chatId) || new Map();
    if (room.size >= MAX_CALL_SIZE) return reply({ error: `This call is full (${MAX_CALL_SIZE} people max).` });
    const isNew = room.size === 0;
    const peers = [...room.keys()].map((id) => publicUser(userById(id)));
    for (const sid of room.values()) io.to(sid).emit('call:peer-joined', { chatId, peer: publicUser(me) });
    room.set(me.id, socket.id);
    calls.set(chatId, room);
    userCall.set(me.id, chatId);
    reply({ peers });
    if (isNew) {
      const summary = chatSummary(chatId, me.id);
      for (const id of chatMembers(chatId)) {
        if (id === me.id || userCall.has(id)) continue;
        io.to('user:' + id).emit('call:ring', {
          chatId,
          from: nameFor(id, me),
          chatName: summary.type === 'class' ? summary.name : null,
        });
      }
    }
    pushChat(chatId);
  });

  // Saying no to a one-on-one call ends it for the caller too.
  socket.on('call:decline', (chatId) => {
    if (!chatId?.startsWith('dm:') || !isMember(me.id, chatId)) return;
    const room = calls.get(chatId);
    if (!room) return;
    for (const sid of room.values()) io.to(sid).emit('call:declined', { chatId, by: me.name });
  });

  socket.on('call:leave', () => leaveCall(me.id));

  // Pass WebRTC offers, answers and network info between two people in the same call.
  socket.on('signal', ({ to, data } = {}) => {
    const chatId = userCall.get(me.id);
    const room = chatId && calls.get(chatId);
    if (!room || room.get(me.id) !== socket.id || !room.has(to)) return;
    io.to(room.get(to)).emit('signal', { from: me.id, data });
  });

  socket.on('disconnect', () => {
    const chatId = userCall.get(me.id);
    if (chatId && calls.get(chatId)?.get(me.id) === socket.id) leaveCall(me.id);
    onlineCount.set(me.id, onlineCount.get(me.id) - 1);
    if (!isOnline(me.id)) onlineCount.delete(me.id);
    broadcastPresence(me.id);
  });
});

server.listen(PORT, () => {
  console.log(`Classlinked running at http://localhost:${PORT} (sign-ups limited to @${DOMAIN})`);
});
