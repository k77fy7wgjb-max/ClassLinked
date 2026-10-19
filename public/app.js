const $ = (id) => document.getElementById(id);

let config = { iceServers: [] };
let me = null;
let socket = null;
let mode = 'login';

const chats = new Map(); // chatId -> chat summary from the server
const unread = new Map(); // chatId -> count
let openChatId = null;

// Call state. Everyone in a call connects directly to everyone else.
let call = null; // { chatId, peers: Map(peerId -> { pc, name, tile, pending }) }
let localStream = null;
let ringing = null; // { chatId }

// ---------- Helpers ----------
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($('toast').hidden = true), 3500);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// socket.emit that waits for the server's answer.
const ask = (event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const timeOf = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ---------- Log in / sign up ----------
function setMode(m) {
  mode = m;
  $('loginTab').classList.toggle('active', m === 'login');
  $('signupTab').classList.toggle('active', m === 'signup');
  $('nameRow').hidden = m !== 'signup';
  $('name').required = m === 'signup';
  $('authSubmit').textContent = m === 'signup' ? 'Create account' : 'Log in';
  $('password').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
  $('authError').hidden = true;
}
$('loginTab').onclick = () => setMode('login');
$('signupTab').onclick = () => setMode('signup');

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  $('authError').hidden = true;
  try {
    const body = { email: $('email').value, password: $('password').value };
    if (mode === 'signup') body.name = $('name').value;
    me = await api(mode === 'signup' ? '/api/signup' : '/api/login', body);
    showApp();
  } catch (err) {
    $('authError').textContent = err.message;
    $('authError').hidden = false;
  }
};

$('logoutBtn').onclick = $('homeLogoutBtn').onclick = async () => {
  leaveCall();
  await api('/api/logout', {});
  location.reload();
};

function showApp() {
  $('authView').hidden = true;
  $('whoami').hidden = false;
  $('myName').textContent = me.name;
  $('myNumber').textContent = $('homeNumber').textContent = me.number;
  connectSocket();
  showHome();
}

// ---------- Home page ----------
let homeCamStream = null;

function showHome() {
  document.body.classList.add('space', 'home');
  $('appView').hidden = true;
  $('homeView').hidden = false;
  startGalaxy();
  startHomeCam();
}

function showChats() {
  stopHomeCam();
  document.body.classList.remove('home');
  $('homeView').hidden = true;
  $('appView').hidden = false;
}

async function startHomeCam() {
  if (homeCamStream || call) return;
  try {
    homeCamStream = await navigator.mediaDevices.getUserMedia({ video: true });
    if ($('homeView').hidden || call) return stopHomeCam(); // left the page while waiting
    $('homeCam').srcObject = homeCamStream;
    $('camStartBtn').hidden = true;
  } catch {
    $('camStartBtn').hidden = false;
  }
}

function stopHomeCam() {
  if (homeCamStream) homeCamStream.getTracks().forEach((t) => t.stop());
  homeCamStream = null;
  $('homeCam').srcObject = null;
}

$('camStartBtn').onclick = startHomeCam;
$('homeLink').onclick = showHome;
$('homeChatBtn').onclick = showChats;
$('homeCallBtn').onclick = () => {
  const list = $('callPickList');
  list.replaceChildren();
  for (const chat of chats.values()) {
    const li = el('li');
    const avatar = el('div', 'avatar' + (chat.type === 'class' ? ' class' : ''), initials(chat.name));
    const name = el('div', 'grow chat-title', chat.name);
    const callBtn = el('button', 'primary', 'Call');
    callBtn.onclick = () => startFromPicker(chat.id);
    li.append(avatar, name, callBtn);
    list.append(li);
  }
  $('callPickEmpty').hidden = chats.size > 0;
  $('callPickDialog').showModal();
};
$('callPickDialog').querySelector('.cancel').onclick = () => $('callPickDialog').close();

// Starts a call, or joins it if one is already going in that chat.
function startFromPicker(chatId) {
  $('callPickDialog').close();
  joinCall(chatId);
}

// Twinkling stars drawn behind the home page.
let galaxyStarted = false;
function startGalaxy() {
  if (galaxyStarted) return;
  galaxyStarted = true;
  const canvas = $('galaxy');
  const ctx = canvas.getContext('2d');
  let stars = [];
  function resize() {
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    const count = Math.round((innerWidth * innerHeight) / 2500);
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: (Math.random() * 1.3 + 0.3) * devicePixelRatio,
      speed: Math.random() * 0.002 + 0.0005,
      phase: Math.random() * Math.PI * 2,
    }));
  }
  function draw(t) {
    if (document.body.classList.contains('space')) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of stars) {
        ctx.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(s.phase + t * s.speed));
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    requestAnimationFrame(draw);
  }
  addEventListener('resize', resize);
  resize();
  requestAnimationFrame(draw);
}

// ---------- Chat list ----------
function renderChatList() {
  const list = $('chatList');
  list.replaceChildren();
  const sorted = [...chats.values()].sort((a, b) => (b.last?.at || 0) - (a.last?.at || 0));
  for (const chat of sorted) {
    const li = el('li', chat.id === openChatId ? 'active' : '');
    const avatar = el('div', 'avatar' + (chat.type === 'class' ? ' class' : ''), initials(chat.name));
    if (chat.type === 'dm' && chat.members.find((m) => m.id !== me.id)?.online) avatar.append(el('span', 'dot'));
    const text = el('div', 'grow');
    text.append(el('div', 'chat-title', chat.name));
    const preview = chat.last
      ? (chat.type === 'class' && chat.last.from !== me.id
          ? (chat.members.find((m) => m.id === chat.last.from)?.name || chat.last.fromName) + ': '
          : '') + chat.last.text
      : chat.subtitle;
    text.append(el('div', 'chat-preview', preview));
    li.append(avatar, text);
    if (chat.call.length) li.append(el('span', 'incall', 'In call'));
    if (unread.get(chat.id)) li.append(el('span', 'badge', unread.get(chat.id)));
    li.onclick = () => openChat(chat.id);
    list.append(li);
  }
  $('noChats').hidden = chats.size > 0;
}

function upsertChat(chat) {
  chats.set(chat.id, chat);
  // If someone hung up before we answered, stop ringing.
  if (ringing?.chatId === chat.id && chat.call.length === 0) hideRing();
  renderChatList();
  if (chat.id === openChatId) renderChatHeader();
}

// ---------- Open chat ----------
async function openChat(chatId) {
  openChatId = chatId;
  unread.delete(chatId);
  document.body.classList.add('chat-open');
  $('noChatOpen').hidden = true;
  $('chatOpen').hidden = false;
  renderChatList();
  renderChatHeader();
  $('messages').replaceChildren();
  const history = await ask('chat:history', chatId);
  if (openChatId !== chatId) return;
  history.forEach(addMessage);
  $('msgInput').focus();
}

function renderChatHeader() {
  const chat = chats.get(openChatId);
  if (!chat) return;
  $('chatName').textContent = chat.name;
  let sub = chat.subtitle;
  if (chat.type === 'dm') sub += chat.members.find((m) => m.id !== me.id)?.online ? ' · online' : ' · offline';
  $('chatSub').textContent = sub;

  const callRunning = chat.call.length > 0 && call?.chatId !== chat.id;
  $('callBanner').hidden = !callRunning;
  if (callRunning) {
    const names = chat.call.map((id) => chat.members.find((m) => m.id === id)?.name).filter(Boolean);
    $('callBannerText').textContent = `Call going on with ${names.join(', ')}`;
    $('joinCallBtn').disabled = !!call;
  }

  $('classMenu').hidden = chat.type !== 'class';
  if (chat.type === 'class') {
    $('memberList').textContent = chat.members.map((m) => `${m.name} (${m.number})`).join(', ');
  }
}

function addMessage(msg, list = $('messages')) {
  const chat = chats.get(msg.chatId);
  const mine = msg.from === me.id;
  const li = el('li', mine ? 'mine' : '');
  li.append(el('div', 'bubble', msg.text));
  const sender = chat?.members.find((m) => m.id === msg.from);
  const who = chat?.type === 'class' && !mine ? (sender?.name || msg.fromName) + ' · ' : '';
  li.append(el('div', 'meta', who + timeOf(msg.at)));
  list.append(li);
  list.scrollTop = list.scrollHeight;
}

$('backBtn').onclick = () => {
  openChatId = null;
  document.body.classList.remove('chat-open');
  $('chatOpen').hidden = true;
  $('noChatOpen').hidden = false;
  renderChatList();
};

$('composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('msgInput').value.trim();
  if (!text) return;
  socket.emit('msg:send', { chatId: openChatId, text });
  $('msgInput').value = '';
};

// ---------- New chat / class dialogs ----------
function setupDialog(dialogId, openBtnId, onSubmit, onOpen) {
  const dialog = $(dialogId);
  const form = dialog.querySelector('form');
  const error = dialog.querySelector('.error');
  $(openBtnId).onclick = () => {
    form.reset();
    error.hidden = true;
    if (onOpen) onOpen();
    dialog.showModal();
  };
  dialog.querySelector('.cancel').onclick = () => dialog.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const res = await onSubmit();
    if (res.error) {
      error.textContent = res.error;
      error.hidden = false;
      return;
    }
    dialog.close();
    if (res.chat) {
      upsertChat(res.chat);
      openChat(res.chat.id);
    }
  };
}

setupDialog('newClassDialog', 'newClassBtn', () =>
  ask('class:create', { name: $('newClassName').value, numbers: $('newClassNumbers').value }),
);

// ---------- Add someone: their number, then their name ----------
let addClassChatId = null; // set when adding from inside a class

function openAddFlow(classChatId) {
  addClassChatId = classChatId || null;
  const cls = addClassChatId && chats.get(addClassChatId);
  $('addNumberHint').textContent = cls ? `They'll be saved to your contacts and added to ${cls.name}.` : '';
  $('addNumberHint').hidden = !cls;
  $('addNumberForm').reset();
  $('addNumberDialog').querySelector('.error').hidden = true;
  $('addNumberDialog').showModal();
}

function showError(dialogId, msg) {
  const error = $(dialogId).querySelector('.error');
  error.textContent = msg;
  error.hidden = false;
}

$('addBtn').onclick = () => {
  const chat = chats.get(openChatId);
  openAddFlow(chat?.type === 'class' ? chat.id : null);
};
$('newChatBtn').onclick = () => openAddFlow(null);
$('addNumberDialog').querySelector('.cancel').onclick = () => $('addNumberDialog').close();
// Hide an old error once they start typing again.
$('addNumber').oninput = () => ($('addNumberDialog').querySelector('.error').hidden = true);

$('addNumberForm').onsubmit = async (e) => {
  e.preventDefault();
  const res = await ask('contact:check', $('addNumber').value);
  if (res.error) return showError('addNumberDialog', res.error);
  $('addNumberDialog').close();
  $('addInfoForm').reset();
  $('addInfoDialog').querySelector('.error').hidden = true;
  $('addInfoNumber').textContent = res.number;
  $('addInfoDialog').showModal();
};

$('addInfoDialog').querySelector('.back-step').onclick = () => {
  $('addInfoDialog').close();
  $('addNumberDialog').showModal();
};

$('addInfoForm').onsubmit = async (e) => {
  e.preventDefault();
  const res = await ask('contact:save', {
    number: $('addInfoNumber').textContent,
    name: $('addName').value,
    classChatId: addClassChatId,
  });
  if (res.error) return showError('addInfoDialog', res.error);
  $('addInfoDialog').close();
  upsertChat(res.chat);
  openChat(res.chat.id);
  toast(`Saved ${$('addName').value}.`);
};

$('leaveClassBtn').onclick = () => {
  if (openChatId) socket.emit('class:leave', openChatId);
};

// ---------- Live connection ----------
function connectSocket() {
  socket = io();
  socket.on('connect_error', () => toast('Lost connection to the server. Retrying...'));

  socket.on('chats', (list) => {
    chats.clear();
    list.forEach((c) => chats.set(c.id, c));
    renderChatList();
    if (openChatId && chats.has(openChatId)) renderChatHeader();
  });
  socket.on('chat', upsertChat);
  socket.on('chat:removed', (chatId) => {
    chats.delete(chatId);
    if (openChatId === chatId) $('backBtn').onclick();
    renderChatList();
  });

  socket.on('presence', ({ id, online }) => {
    for (const chat of chats.values()) {
      const m = chat.members.find((x) => x.id === id);
      if (m) m.online = online;
    }
    renderChatList();
    if (openChatId) renderChatHeader();
  });

  socket.on('msg', (msg) => {
    const chat = chats.get(msg.chatId);
    if (chat) chat.last = msg;
    if (msg.chatId === call?.chatId) addMessage(msg, $('callMessages'));
    if (msg.chatId === openChatId) addMessage(msg);
    else if (msg.from !== me.id && msg.chatId !== call?.chatId) unread.set(msg.chatId, (unread.get(msg.chatId) || 0) + 1);
    renderChatList();
  });

  // --- Call events ---
  socket.on('call:ring', ({ chatId, from, chatName }) => {
    if (call) return;
    ringing = { chatId };
    $('ringText').textContent = chatName ? `${from} started a call in ${chatName}` : `${from} is calling you`;
    $('ringBox').hidden = false;
  });

  socket.on('call:peer-joined', ({ chatId, peer }) => {
    if (call?.chatId !== chatId) return;
    addPeer(peer, false);
    updateCallStatus();
  });

  socket.on('call:peer-left', ({ chatId, peerId }) => {
    if (call?.chatId !== chatId) return;
    removePeer(peerId);
    if (chatId.startsWith('dm:') && call.peers.size === 0) {
      toast('Call ended.');
      leaveCall();
    } else updateCallStatus();
  });

  socket.on('call:declined', ({ chatId, by }) => {
    if (call?.chatId !== chatId) return;
    toast(`${by} declined.`);
    leaveCall();
  });

  socket.on('signal', async ({ from, data }) => {
    const peer = call?.peers.get(from);
    if (!peer) return;
    const { pc } = peer;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const c of peer.pending) await pc.addIceCandidate(c);
      peer.pending = [];
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else peer.pending.push(data.candidate);
    }
  });
}

// ---------- Calls ----------
// Calls are video only and always muted: the microphone is never turned on.
async function getCamera() {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch {
    toast("No camera, so others won't see you. You can still watch and use the call chat.");
    return new MediaStream();
  }
}

async function joinCall(chatId) {
  if (call) return;
  stopHomeCam();
  localStream = await getCamera();
  call = { chatId, peers: new Map() };
  showCallView();
  const res = await ask('call:join', { chatId });
  if (res.error) {
    toast(res.error);
    return leaveCall(false);
  }
  // The newest person sends a connection offer to everyone already there.
  for (const peer of res.peers) addPeer(peer, true);
  updateCallStatus();
}

function addPeer(peer, sendOffer) {
  const pc = new RTCPeerConnection({ iceServers: config.iceServers });
  const tile = makeTile(peer.name, false);
  const entry = { pc, name: peer.name, tile, pending: [] };
  call.peers.set(peer.id, entry);

  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  // Without a camera, still ask to receive the other person's video.
  if (!localStream.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: peer.id, data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    tile.querySelector('video').srcObject = e.streams[0] || new MediaStream([e.track]);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      toast(`Couldn't connect to ${peer.name}. The network may be blocking calls.`);
    }
    updateCallStatus();
  };
  if (sendOffer) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => socket.emit('signal', { to: peer.id, data: { sdp: pc.localDescription } }));
  }
}

function removePeer(peerId) {
  const peer = call?.peers.get(peerId);
  if (!peer) return;
  peer.pc.close();
  peer.tile.remove();
  call.peers.delete(peerId);
}

const MIC_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/><line class="slash" x1="4" y1="4" x2="20" y2="20"/></svg>';

function makeTile(name, isMe) {
  const tile = el('div', 'tile');
  const video = el('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isMe) {
    video.muted = true;
    video.srcObject = localStream;
  }
  // Small mute sign in the corner. Calls have no sound, so everyone is always muted.
  const mic = el('span', 'mic muted');
  mic.innerHTML = MIC_ICON;
  mic.title = 'Muted';
  tile.append(video, el('span', 'label', name), mic);
  $('tiles').append(tile);
  return tile;
}

function showCallView() {
  $('tiles').replaceChildren();
  makeTile('You', true);
  const hasVideo = localStream.getVideoTracks().length > 0;
  $('camBtn').hidden = !hasVideo;
  $('camBtn').textContent = 'Camera off';
  $('callView').hidden = false;
  renderChatHeader();
  loadCallChat(call.chatId);
}

// The call chat is the same chat the call started from, so texts stay afterwards.
async function loadCallChat(chatId) {
  $('callMessages').replaceChildren();
  const history = await ask('chat:history', chatId);
  if (call?.chatId !== chatId) return;
  history.slice(-50).forEach((m) => addMessage(m, $('callMessages')));
}

$('callComposer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('callMsgInput').value.trim();
  if (!text || !call) return;
  socket.emit('msg:send', { chatId: call.chatId, text });
  $('callMsgInput').value = '';
};

function updateCallStatus() {
  if (!call) return;
  const chat = chats.get(call.chatId);
  const peers = [...call.peers.values()];
  if (peers.length === 0) {
    $('callStatus').textContent = chat?.type === 'dm' ? `Calling ${chat.name}...` : `Waiting for people to join ${chat?.name || ''}...`;
    return;
  }
  const connected = peers.filter((p) => p.pc.connectionState === 'connected').length;
  const label = chat?.type === 'class' ? chat.name : `Call with ${chat?.name}`;
  $('callStatus').textContent =
    connected === peers.length ? `${label} · ${peers.length + 1} people` : `${label} · connecting...`;
}

function leaveCall(tellServer = true) {
  if (call) {
    if (tellServer) socket.emit('call:leave');
    for (const id of [...call.peers.keys()]) removePeer(id);
  }
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  call = null;
  localStream = null;
  $('tiles').replaceChildren();
  $('callView').hidden = true;
  if (openChatId) renderChatHeader();
  if (!$('homeView').hidden) startHomeCam();
}

function hideRing() {
  ringing = null;
  $('ringBox').hidden = true;
}

$('joinCallBtn').onclick = () => joinCall(openChatId);
$('hangupBtn').onclick = () => leaveCall();

$('acceptBtn').onclick = () => {
  const { chatId } = ringing;
  hideRing();
  joinCall(chatId);
};
$('declineBtn').onclick = () => {
  if (ringing.chatId.startsWith('dm:')) socket.emit('call:decline', ringing.chatId);
  hideRing();
};

$('camBtn').onclick = () => {
  const track = localStream.getVideoTracks()[0];
  track.enabled = !track.enabled;
  $('camBtn').textContent = track.enabled ? 'Camera off' : 'Camera on';
};

// ---------- Start ----------
(async () => {
  config = await api('/api/config');
  $('domainHint').textContent = '@' + config.domain;
  $('email').placeholder = 'you@' + config.domain;
  try {
    me = await api('/api/me');
    showApp();
  } catch {
    document.body.classList.add('space', 'home');
    startGalaxy();
    $('authView').hidden = false;
  }
})();
