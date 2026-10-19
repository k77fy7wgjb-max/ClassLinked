# Classlinked

A website where students at one school can text, voice call and video call each
other, one-on-one or as a whole class, right in the browser.

- **Sign up with your school email.** Only emails at your school's domain (for
  example `@myschool.edu`) can make an account.
- **Everyone gets a Classlinked number**, like `482-1937`. It shows at the top of
  the page. Give it to friends so they can text or call you.
- **Add** (or **New chat**): type someone's number, then a second popup asks for
  their name. They're saved to your contacts under that name and a chat opens.
  Pressing Add inside a class also adds them to the class.
- **New class**: give it a name and paste in a list of numbers. Everyone in the
  class gets a group chat.
- **Calls** start from the **Call** button on the home page: pick a person or a
  class, then press Call. Everyone gets a ring and can answer or decline;
  people can also join later with the **Join** bar at the top of the chat.
- **In a call** the cameras sit side by side with a chat for the call underneath.
  Calls are video only and always muted: the site never turns on anyone's
  microphone, so people talk in the call chat. A mute sign sits in the corner of
  each camera.
- Audio and video go straight between browsers (WebRTC). The server only passes
  texts and helps browsers find each other, so it stays cheap to run.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

1. Open a terminal in this folder.
2. Copy `.env.example` to a new file named `.env` and change `ALLOWED_EMAIL_DOMAIN`
   to your school's email domain. Put any long random text in `SESSION_SECRET`.
3. Run:
   ```
   npm install
   npm start
   ```
4. Open http://localhost:3000. To try it alone, open a second browser (or a private
   window), sign up as a second student, and text or call yourself using the number.

Browsers only allow the camera and microphone on `localhost` or on an `https://`
site, so for classmates on other computers you need to put it online (below).

## Put it online (Render, free)

1. Put this folder in a GitHub repository.
2. On [render.com](https://render.com), create a **Web Service** from that repository.
3. Build command: `npm install`. Start command: `npm start`.
4. Under **Environment**, add `ALLOWED_EMAIL_DOMAIN` (your school's domain) and
   `SESSION_SECRET` (long random text).
5. Render gives you an `https://...onrender.com` link to share.

Everything is saved in the `data/` folder (accounts, classes, the last 500 texts
per chat). On Render's free plan that folder is wiped whenever the app restarts or
redeploys. Adding a Render disk mounted at `data/` keeps it.

## Making calls work on school Wi-Fi

Many school and public networks block the direct connections video calls use. Then
a call shows "connecting..." and never connects. The fix is a **TURN relay**: a
server that passes the call along over normal web ports. Get one from a provider
(some have free tiers, for example Metered or Twilio), then set `TURN_URL`,
`TURN_USERNAME` and `TURN_CREDENTIAL` as shown in `.env.example`. Including a
`turns:` address on port 443 works on the most networks.

This only helps calls connect. If your school's filter blocks the website itself,
ask your school's IT staff to allow it; it is a lot easier to get approved if a
teacher is on board.

## Known limits of this version

- **Group calls max out at 10 people** (change with `MAX_CALL_SIZE`). Each person
  sends their video to everyone else, which gets choppy past about 10. A full class
  of 25 to 30 needs a media server (for example LiveKit) in the middle.
- **Email isn't verified.** Anyone who types an address ending in your school's
  domain can sign up, even if it isn't their inbox.
- No blocking, reporting or deleting messages yet. Add these before lots of
  people use it.
- Check your school's rules before running a site for students.

## Files

- `server.js`: accounts, numbers, chats, classes, texts, who's online, and passing
  call setup messages.
- `public/index.html`, `public/style.css`: the page.
- `public/app.js`: everything in the browser, including the calling code.
