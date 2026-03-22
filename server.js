require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const path       = require('path');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sessionApiKey  = process.env.GROQ_API_KEY || '';
let oauthTokens    = null;
let pendingArticle = null;
let oauth2Client   = null;

// ── Pre-load all platform credentials from .env ────────────────
const envCreds = {
  blogger:  { clientId: process.env.BLOGGER_CLIENT_ID || '', clientSecret: process.env.BLOGGER_CLIENT_SECRET || '', blogId: process.env.BLOGGER_BLOG_ID || '' },
  devto:    { apiKey: process.env.DEVTO_API_KEY || '' },
  hashnode: { apiKey: process.env.HASHNODE_API_KEY || '', publicationId: process.env.HASHNODE_PUBLICATION_ID || '' },
  tumblr:   { apiKey: process.env.TUMBLR_API_KEY || '', blogName: process.env.TUMBLR_BLOG_NAME || '' },
  site:     { backlink: process.env.BACKLINK_URL || '', niche: process.env.WEBSITE_NICHE || '' }
};

// ── Scheduler state ────────────────────────────────────────────
let schedulerRunning  = false;
let schedulerInterval = null;
let schedulerLog      = [];
let sseClients        = [];

function pushLog(msg, type = 'info') {
  const line = { time: new Date().toTimeString().slice(0,8), msg, type };
  schedulerLog.push(line);
  if (schedulerLog.length > 500) schedulerLog.shift();
  sseClients.forEach(c => { try { c.write(`data: ${JSON.stringify(line)}\n\n`); } catch(e){} });
}

// ── SSE live log ───────────────────────────────────────────────
app.get('/api/log-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  schedulerLog.slice(-100).forEach(l => res.write(`data: ${JSON.stringify(l)}\n\n`));
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

// ── OAuth2 helpers ─────────────────────────────────────────────
function getOAuthClient(clientId, clientSecret) {
  if (!oauth2Client || oauth2Client._clientId !== clientId) {
    oauth2Client = new google.auth.OAuth2(clientId, clientSecret, `http://localhost:${PORT}/oauth/callback`);
    oauth2Client._clientId = clientId;
  }
  if (oauthTokens) oauth2Client.setCredentials(oauthTokens);
  return oauth2Client;
}

// Auto-refresh token if expired
async function getFreshBloggerClient(clientId, clientSecret) {
  const client = getOAuthClient(clientId, clientSecret);
  // If token expires within next 5 minutes, refresh it
  const expiry = oauthTokens?.expiry_date;
  if (expiry && Date.now() > expiry - 5 * 60 * 1000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      oauthTokens = credentials;
      client.setCredentials(credentials);
      pushLog('Google token refreshed automatically', 'ok');
    } catch(e) {
      pushLog('Token refresh failed: ' + e.message, 'warn');
    }
  }
  return client;
}

// ── GROQ key ───────────────────────────────────────────────────
app.post('/api/setkey', (req, res) => {
  const { key } = req.body;
  if (key && key.length > 10) { sessionApiKey = key.trim(); res.json({ success: true }); }
  else res.status(400).json({ error: 'Invalid API key.' });
});
app.get('/api/keystatus', (req, res) => res.json({ saved: sessionApiKey.length > 10 }));
app.get('/api/env-creds', (req, res) => res.json(envCreds));

// ── AI: Generate 10 topic plan ─────────────────────────────────
async function generateTopicPlan(backlink, websiteNiche) {
  const prompt = `You are an expert SEO strategist. Given website: "${backlink}" and niche: "${websiteNiche || 'general'}",
generate exactly 10 unique SEO blog post ideas that drive backlink value to this site.
For each return: topic, keyword (2-4 words), niche (sub-niche), anchorText (natural link text), instructions (1 sentence).
CRITICAL: Return ONLY a valid JSON array of 10 objects. No markdown, no backticks.
Format: [{"topic":"...","keyword":"...","niche":"...","anchorText":"...","instructions":"..."},...]`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionApiKey}` },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.8, max_tokens: 3000 })
  });
  if (!r.ok) throw new Error('Groq topic plan error: ' + r.status);
  const data = await r.json();
  const raw  = data?.choices?.[0]?.message?.content || '';
  const clean = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
  try { return JSON.parse(clean); }
  catch { const m = clean.match(/\[[\s\S]*\]/); if (m) return JSON.parse(m[0]); throw new Error('Could not parse topic plan'); }
}

// ── AI: Generate single article ────────────────────────────────
async function generateArticle({ topic, backlink, anchorText, length, tone, language, niche, instructions }) {
  const words = { short:500, medium:800, long:1200, pillar:2000 }[length] || 800;
  const prompt = `Write a ${words}-word ${tone||'casual'} SEO article about: "${topic}"
Niche: ${niche||'General'} | Language: ${language||'English'}
${instructions ? 'Instructions: '+instructions : ''}
Embed this backlink ONCE naturally as HTML: <a href="${backlink}">${anchorText||backlink}</a>
Include meta_title (max 60 chars) and meta_description (max 155 chars).
CRITICAL: Reply ONLY with valid JSON. No markdown, no backticks.
Format: {"title":"...","meta_title":"...","meta_description":"...","html_body":"<p>...</p>"}`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionApiKey}` },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role:'system', content:'You are an expert SEO writer. Always respond with valid JSON only.' }, { role:'user', content: prompt }], temperature: 0.7, max_tokens: 4096 })
  });
  if (!r.ok) { const e = await r.json(); throw new Error(e?.error?.message || 'Groq error: ' + r.status); }
  const data  = await r.json();
  const raw   = data?.choices?.[0]?.message?.content || '';
  const clean = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
  try { return JSON.parse(clean); }
  catch { const m = clean.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Could not parse article JSON'); }
}

// ── POST: Blogger (with token auto-refresh) ────────────────────
async function postToBlogger(article, credentials) {
  const { clientId, clientSecret, blogId } = credentials;
  if (!oauthTokens) throw new Error('NOT_AUTHED — connect Google account first');
  const client  = await getFreshBloggerClient(clientId, clientSecret);
  const blogger = google.blogger({ version: 'v3', auth: client });
  let targetBlogId = blogId;
  if (!targetBlogId) {
    const blogs = await blogger.blogs.listByUser({ userId: 'self' });
    targetBlogId = blogs.data.items?.[0]?.id;
  }
  if (!targetBlogId) throw new Error('No Blogger blog found. Create one at blogger.com first.');
  const post = await blogger.posts.insert({ blogId: targetBlogId, requestBody: { title: article.title, content: article.html_body } });
  return { url: post.data.url, id: post.data.id };
}

// ── POST: Dev.to ───────────────────────────────────────────────
async function postToDevto(article, credentials) {
  const { apiKey } = credentials;
  if (!apiKey) throw new Error('Dev.to API key missing');
  const description = (article.meta_description || article.html_body.replace(/<[^>]+>/g,'')).slice(0,150);
  const r = await fetch('https://dev.to/api/articles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({ article: { title: article.title, body_html: article.html_body, description, published: true, tags: [] } })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || d.message || 'Dev.to post failed');
  return { url: d.url, id: d.id };
}

// ── POST: Hashnode ─────────────────────────────────────────────
async function postToHashnode(article, credentials) {
  const { apiKey, publicationId } = credentials;
  if (!apiKey) throw new Error('Hashnode API key missing');
  let pubId = publicationId;
  if (!pubId) {
    const meRes = await fetch('https://gql.hashnode.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
      body: JSON.stringify({ query: `{ me { publications(first:1) { edges { node { id } } } } }` })
    });
    const meData = await meRes.json();
    pubId = meData?.data?.me?.publications?.edges?.[0]?.node?.id;
    if (!pubId) throw new Error('No Hashnode publication found. Create a blog at hashnode.com first.');
  }
  const r = await fetch('https://gql.hashnode.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
    body: JSON.stringify({ query: `mutation PublishPost($input: PublishPostInput!) { publishPost(input: $input) { post { url id } } }`, variables: { input: { title: article.title, contentMarkdown: article.html_body, publicationId: pubId, tags: [] } } })
  });
  const d = await r.json();
  if (d.errors) throw new Error(d.errors[0]?.message || 'Hashnode post failed');
  const post = d?.data?.publishPost?.post;
  return { url: post.url, id: post.id };
}

// ── POST: Tumblr ───────────────────────────────────────────────
async function postToTumblr(article, credentials) {
  const { apiKey, blogName } = credentials;
  if (!apiKey || !blogName) throw new Error('Tumblr credentials missing');
  const blog = blogName.replace(/^https?:\/\//,'').replace(/\/$/,'');
  const r = await fetch(`https://api.tumblr.com/v2/blog/${blog}/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ type: 'text', title: article.title, body: article.html_body })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.meta?.msg || 'Tumblr post failed');
  return { url: `https://${blog}/post/${d.response.id}`, id: d.response.id };
}

// ── Scheduler ──────────────────────────────────────────────────
let schedulerConfig = null;
let schedulerStats  = { total: 0, success: 0, failed: 0, posts: [] };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runDailyBatch() {
  if (!schedulerConfig) return;
  const { backlink, websiteNiche, tone, length, language, platforms } = schedulerConfig;

  pushLog('━━━ Daily batch started ━━━', 'info');
  pushLog(`Generating 10 SEO topic ideas for: ${backlink}`, 'ai');

  let topics;
  try {
    topics = await generateTopicPlan(backlink, websiteNiche);
    pushLog(`Got ${topics.length} topic ideas from AI`, 'ok');
  } catch(e) {
    pushLog('Topic plan failed: ' + e.message, 'err');
    return;
  }

  for (const platform of platforms) {
    pushLog(`── Platform: ${platform.name} ──`, 'info');
    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      pushLog(`[${i+1}/10] Writing: "${t.topic}"`, 'ai');
      await sleep(1000);

      let article;
      try {
        article = await generateArticle({ topic: t.topic, backlink, anchorText: t.anchorText, length, tone, language, niche: t.niche, instructions: t.instructions });
        pushLog(`Article ready: "${article.title}"`, 'ok');
      } catch(e) {
        pushLog(`Generate failed: ${e.message}`, 'err');
        schedulerStats.failed++; schedulerStats.total++;
        await sleep(3000); continue;
      }

      try {
        let result;
        if (platform.type === 'blogger')  result = await postToBlogger(article,  platform.credentials);
        if (platform.type === 'devto')    result = await postToDevto(article,    platform.credentials);
        if (platform.type === 'hashnode') result = await postToHashnode(article,  platform.credentials);
        if (platform.type === 'tumblr')   result = await postToTumblr(article,   platform.credentials);

        pushLog(`Posted to ${platform.name} → ${result.url}`, 'ok');
        schedulerStats.success++;
        schedulerStats.posts.unshift({ platform: platform.name, title: article.title, url: result.url, time: new Date().toLocaleString() });
        if (schedulerStats.posts.length > 100) schedulerStats.posts.pop();
        sseClients.forEach(c => { try { c.write(`data: ${JSON.stringify({ type:'stats', stats: schedulerStats })}\n\n`); } catch(e){} });
      } catch(e) {
        pushLog(`Post to ${platform.name} failed: ${e.message}`, 'err');
        schedulerStats.failed++;
      }
      schedulerStats.total++;
      if (i < topics.length - 1) await sleep(8000);
    }
  }
  pushLog('━━━ Batch complete ━━━', 'ok');
  pushLog('Next batch in 24 hours', 'info');
}

// ── Scheduler API ──────────────────────────────────────────────
app.post('/api/scheduler/start', async (req, res) => {
  const { backlink, websiteNiche, tone, length, language, platforms } = req.body;
  if (!backlink)          return res.status(400).json({ error: 'Website URL required.' });
  if (!sessionApiKey)     return res.status(400).json({ error: 'Groq API key not set.' });
  if (!platforms?.length) return res.status(400).json({ error: 'Select at least one platform.' });
  if (platforms.find(p => p.type === 'blogger') && !oauthTokens) return res.status(400).json({ error: 'NOT_AUTHED_BLOGGER' });

  schedulerConfig  = { backlink, websiteNiche, tone, length, language, platforms };
  schedulerRunning = true;
  schedulerStats   = { total: 0, success: 0, failed: 0, posts: [] };
  res.json({ success: true });
  runDailyBatch();
  schedulerInterval = setInterval(runDailyBatch, 24 * 60 * 60 * 1000);
});

app.post('/api/scheduler/stop', (req, res) => {
  schedulerRunning = false;
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
  schedulerConfig = null;
  pushLog('Scheduler stopped by user.', 'warn');
  res.json({ success: true });
});

app.get('/api/scheduler/status', (req, res) => {
  res.json({ running: schedulerRunning, stats: schedulerStats });
});

app.post('/api/preview-topics', async (req, res) => {
  const { backlink, websiteNiche } = req.body;
  if (!sessionApiKey) return res.status(400).json({ error: 'Groq API key not set.' });
  try { const topics = await generateTopicPlan(backlink, websiteNiche); res.json({ success: true, topics }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Blogger OAuth ──────────────────────────────────────────────
app.post('/api/blogger/auth', (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'Client ID and Secret required.' });
  const client = getOAuthClient(clientId, clientSecret);
  if (oauthTokens) return res.json({ success: true, needsAuth: false });
  const url = client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/blogger'], prompt: 'consent' });
  res.json({ success: true, needsAuth: true, authUrl: url });
});

app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code || !oauth2Client) return res.send('<h2 style="color:red;font-family:sans-serif">Auth failed. Close and try again.</h2>');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    oauthTokens = tokens;
    pushLog('Google OAuth authorized successfully', 'ok');

    if (pendingArticle?.article) {
      const blogger = google.blogger({ version: 'v3', auth: oauth2Client });
      let targetBlogId = pendingArticle.blogId;
      if (!targetBlogId) { const blogs = await blogger.blogs.listByUser({ userId: 'self' }); targetBlogId = blogs.data.items?.[0]?.id; }
      if (!targetBlogId) return res.send(`<html><body style="font-family:sans-serif;background:#0a0a0f;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2 style="color:#ef4444">No blog found.</h2><p>Create one at <a href="https://blogger.com" style="color:#06b6d4">blogger.com</a></p></div></body></html>`);
      const post = await blogger.posts.insert({ blogId: targetBlogId, requestBody: { title: pendingArticle.article.title, content: pendingArticle.article.html_body } });
      const postUrl = post.data.url;
      pendingArticle = null;
      return res.send(`<html><head><script>window.opener&&window.opener.postMessage({type:'BLOGGER_SUCCESS',url:'${postUrl}'},'*');setTimeout(()=>window.close(),2000);</script></head><body style="font-family:sans-serif;background:#0a0a0f;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><div style="font-size:48px">✓</div><h2 style="color:#10b981">Posted!</h2><p><a href="${postUrl}" style="color:#06b6d4">${postUrl}</a></p></div></body></html>`);
    }
    res.send(`<html><head><script>window.opener&&window.opener.postMessage({type:'BLOGGER_AUTHED'},'*');setTimeout(()=>window.close(),1500);</script></head><body style="font-family:sans-serif;background:#0a0a0f;color:#10b981;display:flex;align-items:center;justify-content:center;height:100vh"><h2>✓ Google Connected! Close this tab.</h2></body></html>`);
  } catch(e) { res.send(`<h2 style="color:red;font-family:sans-serif">Error: ${e.message}</h2>`); }
});

app.post('/api/post/blogger', async (req, res) => {
  const { clientId, clientSecret, blogId, article } = req.body;
  if (!oauthTokens) return res.status(401).json({ error: 'NOT_AUTHED' });
  try { const r = await postToBlogger(article, { clientId, clientSecret, blogId }); res.json({ success: true, ...r }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/post/devto', async (req, res) => {
  const { apiKey, article } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'Dev.to API key missing.' });
  try { const r = await postToDevto(article, { apiKey }); res.json({ success: true, ...r }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/post/hashnode', async (req, res) => {
  const { apiKey, publicationId, article } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'Hashnode API key missing.' });
  try { const r = await postToHashnode(article, { apiKey, publicationId }); res.json({ success: true, ...r }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/post/tumblr', async (req, res) => {
  const { apiKey, blogName, article } = req.body;
  try { const r = await postToTumblr(article, { apiKey, blogName }); res.json({ success: true, ...r }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log('');
  console.log('  ✦  AutoPost Pro — AUTOPILOT MODE');
  console.log(`  →  Open: http://localhost:${PORT}`);
  console.log('  →  10 posts/day · Blogger token auto-refresh enabled');
  console.log('');
});
