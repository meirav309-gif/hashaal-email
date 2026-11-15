const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const SMOOVE_TOKEN = process.env.SMOOVE_TOKEN;
// מייל לדוגמה: נשלח רק לכתובת הזו, לא לרשימה, ולא מסמן שום מוצר כנשלח.
const TEST_EMAIL = (process.env.TEST_EMAIL || '').trim();
// שליחה חוזרת: אותם מוצרים שיצאו בתאריך הזה (YYYY-MM-DD), בלי לעדכן את Airtable.
const RESEND_DATE = (process.env.RESEND_DATE || '').trim();

// Cutoff is 2026-06-04 10:00 UTC (13:00 Israel), NOT an arbitrary date. On 2026-06-04
// the Airtable image compression touched the "פידבקים תמונה" field on 289 old records,
// which bumped their computed תאריך עדכון אחרון to ~09:27-09:28 UTC and shoved ~25
// never-sent 2023-2024 products to the front of the daily queue. This cutoff sits after
// that bump window and before the first genuine post-compression edit (12:44 UTC), so the
// queue starts from real new products. Editing any old product re-bumps it past the
// cutoff and brings it back into rotation automatically.
// מוצר במצב טיוטה הוא מוצר שמירב עוד לא אישרה. הוא לא יוצא לרשימת
// התפוצה עד שהיא לוחצת אישור, בדיוק כמו בסטטוס ובקבוצות.
const filterFormula = `AND(NOT({Status}="טיוטה"),NOT({קוד מוצר}="סטוריז"),NOT(SEARCH("פספוסי קניות",{קוד מוצר})),NOT(SEARCH("שבוע טוב",{קוד מוצר})),IS_AFTER({תאריך עדכון אחרון },"2026-06-04T10:00:00.000Z"),OR(NOT({תאריך שליחה במייל}),IS_BEFORE({תאריך שליחה במייל},{תאריך עדכון אחרון })))`;

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Images and the PDF live in the buy4you Supabase bucket "email-media" (public).
// Until 11.11.2026 they went to studio-api.admin.smoove.io/upload, which now refuses
// images and wants an account name for PDFs. Airtable URLs expire after ~2-3 hours,
// so an email must never point at them.
// The email links to buy4you.co.il/email-media/<date>/<file>, not to Supabase: the
// site fetches each file from Supabase once and Cloudflare caches it. Linking to
// Supabase directly (12-15.11.2026) cost ~4 MB of Supabase egress per open and blew
// the free plan's 5 GB quota in 4 days.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const MEDIA_BUCKET = 'email-media';
const MEDIA_PUBLIC_BASE = (process.env.MEDIA_PUBLIC_BASE || 'https://buy4you.co.il/email-media').replace(/\/$/, '');
const MEDIA_KEEP_DAYS = 14;

// Shrinks an image to 600px JPEG (shrink_image.py, Pillow). GIFs stay as they are
// (may be animated). On any failure the original is kept.
async function shrinkImage(buf) {
  if (buf.slice(0, 3).toString() === 'GIF') return buf;
  const stamp = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const src = path.join(os.tmpdir(), `shrink_in_${stamp}`);
  const dst = path.join(os.tmpdir(), `shrink_out_${stamp}.jpg`);
  try {
    fs.writeFileSync(src, buf);
    await new Promise((resolve, reject) =>
      execFile('python', [path.join(__dirname, 'shrink_image.py'), src, dst], (err, _out, stderr) =>
        err ? reject(new Error(stderr || err.message)) : resolve()));
    const out = fs.readFileSync(dst);
    return out.length && out.length < buf.length ? out : buf;
  } catch (e) {
    console.error('  הקטנת תמונה נכשלה, נשארת המקורית:', e.message.slice(0, 200));
    return buf;
  } finally {
    for (const f of [src, dst]) { try { fs.unlinkSync(f); } catch {} }
  }
}

function imageMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return ['image/png', 'png'];
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return ['image/webp', 'webp'];
  if (buf.slice(0, 3).toString() === 'GIF') return ['image/gif', 'gif'];
  return ['image/jpeg', 'jpg'];
}

function supabaseRequest(method, apiPath, body, contentType) {
  const u = new URL(SUPABASE_URL + apiPath);
  const headers = { Authorization: `Bearer ${SUPABASE_SECRET_KEY}`, apikey: SUPABASE_SECRET_KEY };
  if (body) { headers['Content-Type'] = contentType; headers['Content-Length'] = body.length; headers['x-upsert'] = 'true'; }
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, text: d }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function uploadMedia(buf, contentType, name) {
  const day = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().split('T')[0];
  const objectPath = `${day}/${name}`;
  const res = await supabaseRequest('POST', `/storage/v1/object/${MEDIA_BUCKET}/${objectPath}`, buf, contentType);
  if (res.status !== 200) throw new Error(`Supabase upload ${res.status}: ${res.text.slice(0, 200)}`);
  return `${MEDIA_PUBLIC_BASE}/${objectPath}`;
}

// Deletes date folders older than MEDIA_KEEP_DAYS so the bucket does not grow forever.
async function cleanupOldMedia() {
  try {
    const cutoff = new Date(Date.now() - MEDIA_KEEP_DAYS * 86400000).toISOString().split('T')[0];
    const list = await supabaseRequest('POST', `/storage/v1/object/list/${MEDIA_BUCKET}`,
      Buffer.from(JSON.stringify({ prefix: '', limit: 1000 })), 'application/json');
    const folders = JSON.parse(list.text).map(o => o.name).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n) && n < cutoff);
    for (const folder of folders) {
      const files = await supabaseRequest('POST', `/storage/v1/object/list/${MEDIA_BUCKET}`,
        Buffer.from(JSON.stringify({ prefix: folder + '/', limit: 1000 })), 'application/json');
      const prefixes = JSON.parse(files.text).map(f => `${folder}/${f.name}`);
      if (prefixes.length) {
        await supabaseRequest('DELETE', `/storage/v1/object/${MEDIA_BUCKET}`,
          Buffer.from(JSON.stringify({ prefixes })), 'application/json');
      }
      console.log(`נמחקה תיקיית מדיה ישנה: ${folder} (${prefixes.length} קבצים)`);
    }
  } catch (e) {
    console.error('ניקוי מדיה ישנה נכשל:', e.message);
  }
}

const smooveUrlCache = new Map();
let imageCounter = 0;

async function uploadImageToSmoove(airtableUrl) {
  if (smooveUrlCache.has(airtableUrl)) return smooveUrlCache.get(airtableUrl);
  try {
    const imageData = await shrinkImage(await downloadBuffer(airtableUrl));
    const [mime, ext] = imageMime(imageData);
    const url = await uploadMedia(imageData, mime, `img_${Date.now()}_${imageCounter++}.${ext}`);
    smooveUrlCache.set(airtableUrl, url);
    return url;
  } catch (e) {
    console.error('  העלאת תמונה נכשלה:', e.message);
    return airtableUrl; // fallback to original
  }
}

async function uploadRecordImages(records, { maxFeedback = 3, maxWp = 6 } = {}) {
  const urlMap = new Map();
  const allUrls = [];
  for (const r of records) {
    const f = r.fields;
    for (const img of (f['פידבקים תמונה '] || []).slice(0, maxFeedback)) if (img.url) allUrls.push(img.url);
    for (const img of (f['תמונות לוואטסאפ'] || []).slice(0, maxWp)) if (img.url) allUrls.push(img.url);
  }
  const unique = [...new Set(allUrls)];
  console.log(`מעלה ${unique.length} תמונות ל-smoove...`);
  for (const url of unique) {
    const smooveUrl = await uploadImageToSmoove(url);
    urlMap.set(url, smooveUrl);
    process.stdout.write('.');
  }
  console.log('');
  return urlMap;
}

function imgTag(url) {
  return `<img src="${url}" style="max-width:560px;width:100%;display:block;margin-bottom:8px;border-radius:8px;" />`;
}

// Match the retired cashback paragraph + its referral URL on the next line.
// The block was stamped into every aliexpress draft until 2026-06-09; we strip
// it at email-build time instead of editing Airtable (would bump 60+ rows of
// תאריך עדכון אחרון and disrupt the daily queue ordering).
// Self-disables on 2026-06-24 — by then the ~63 pending cashback records will
// have all gone out (218 emails / ~36 per day). Past that date, the strip is a
// no-op; the line below and this constant can be deleted in a later cleanup.
const CASHBACK_BLOCK_RE = /רוצים לקבל קאשבק[^\n]*\n+https?:\/\/s\.click\.aliexpress\.com\/e\/_c3cNkFs1\n?/g;
const CASHBACK_STRIP_UNTIL = new Date('2026-06-24T00:00:00Z');

// WhatsApp group join block — strip permanently from every email body. The
// block lives in Airtable descriptions (intro line + chat.whatsapp.com URL)
// and stays there; we only hide it in the email.
const WHATSAPP_GROUP_BLOCK_RE = /\n*לעוד מוצרים הצטרפו לקבוצה[^\n]*\n+https?:\/\/chat\.whatsapp\.com\/\S+/g;

function buildProductHtml(record, urlMap, { maxFeedback = 3, maxWp = 6 } = {}) {
  const f = record.fields;
  const feedbackImgs = f['פידבקים תמונה '] || [];
  const wpImgs = f['תמונות לוואטסאפ'] || [];
  const stripCashback = new Date() < CASHBACK_STRIP_UNTIL;
  let rawDesc = f['תיאור'] || '';
  if (stripCashback) rawDesc = rawDesc.replace(CASHBACK_BLOCK_RE, '');
  rawDesc = rawDesc.replace(WHATSAPP_GROUP_BLOCK_RE, '').trim();
  const description = rawDesc.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  let html = `<div dir="rtl" style="margin-bottom:28px;padding-bottom:28px;border-bottom:2px solid #f0f0f0;font-family:Arial,sans-serif;">`;
  for (const img of feedbackImgs.slice(0, maxFeedback)) if (img.url) html += imgTag(urlMap.get(img.url) || img.url);
  for (const img of wpImgs.slice(0, maxWp)) if (img.url) html += imgTag(urlMap.get(img.url) || img.url);
  html += `<p style="white-space:pre-line;font-size:14px;line-height:1.7;color:#333;margin:12px 0 0;">${description}</p>`;
  html += `</div>`;
  return html;
}

const LOGO_URL   = 'https://content.vp4.me/shalal/Content/IMG_20230226_200201_169_590x590-r.jpg';
const SIGNUP_URL = 'https://lp.vp4.me/oyz4';
const SITE_URL   = 'https://buy4you.co.il/?utm_source=smoove&utm_medium=email&utm_campaign=daily';
const BTN_COLOR  = '#D4746E';
const CASHBACK_URL = 'https://s.click.aliexpress.com/e/_c3cNkFs1';
const CASHBACK_END = '2026-06-10'; // promo ends June 10 at midnight (last send: June 10)
const CASHBACK_SUBJECT_MORNING = '🔥 התחיל מבצע קאשבק! 10 ימים של מוצרים חמים + כסף חזרה';
const CASHBACK_SUBJECT_EVENING = '🌙 עוד מוצרים שווים לערב + קאשבק על כל קנייה';
const REGULAR_SUBJECT = '🔥 השלל החם ברשת - מוצרים של היום';
// Subject window: on Israel dates from..until (inclusive), either replace the subject
// entirely (subject) or append a suffix (suffix). subject wins if both are set.
const SUBJECT_WINDOW = { from: '2026-07-27', until: '2026-08-26', subject: 'סייל חזרה לבית הספר עם הנחות וקופונים משתלמים' };

function israelHour() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).getUTCHours();
}

function isEveningRun() {
  return israelHour() >= 14;
}

function isCashbackPromoActive() {
  const israelNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const today = israelNow.toISOString().split('T')[0];
  return today <= CASHBACK_END;
}

function currentSubject() {
  if ((process.env.SUBJECT_OVERRIDE || '').trim()) return process.env.SUBJECT_OVERRIDE.trim();
  const base = isCashbackPromoActive()
    ? (isEveningRun() ? CASHBACK_SUBJECT_EVENING : CASHBACK_SUBJECT_MORNING)
    : REGULAR_SUBJECT;
  const todayIL = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().split('T')[0];
  const inWindow = todayIL >= SUBJECT_WINDOW.from && todayIL <= SUBJECT_WINDOW.until;
  if (!inWindow) return base;
  if (SUBJECT_WINDOW.subject) return SUBJECT_WINDOW.subject;
  if (SUBJECT_WINDOW.suffix) return base + SUBJECT_WINDOW.suffix;
  return base;
}

function cashbackBanner() {
  return `<div style="background:#FFF4E5;border:1px solid #F5C97B;border-radius:10px;padding:16px 18px;margin-bottom:24px;text-align:right;line-height:1.7;font-size:14px;color:#5a3a00;">` +
    `<p style="font-size:16px;font-weight:bold;margin:0 0 8px;color:#9C5500;">🔥 מבצע מיוחד — 10 ימי קאשבק!</p>` +
    `<p style="margin:0 0 8px;">בימים הקרובים נשלח אלייכם <b>פעמיים ביום</b> (בוקר וערב) את המוצרים הכי שווים ברשת.</p>` +
    `<p style="margin:0 0 10px;">אל תפספסו — המבצע מסתיים ב-10.6.</p>` +
    `<a href="${CASHBACK_URL}" style="display:inline-block;background:#D4746E;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:14px;font-weight:bold;">להצטרפות למבצע הקאשבק »</a>` +
    `</div>`;
}

function buildEmailHtml(productsHtml) {
  const banner = isCashbackPromoActive() ? cashbackBanner() : '';
  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="UTF-8"/></head>` +
    `<body style="font-family:Arial,sans-serif;direction:rtl;text-align:right;max-width:600px;margin:0 auto;padding:20px;background:#fff;">` +
    `<div style="text-align:center;margin-bottom:24px;">` +
    `<a href="${SITE_URL}"><img src="${LOGO_URL}" style="max-width:280px;width:100%;border-radius:12px;display:block;margin:0 auto 14px;border:0;" /></a>` +
    `<p style="font-size:18px;font-weight:bold;color:#222;margin:0 0 14px;">✨ הפריטים הכי שווים ברשת ✨</p>` +
    `<a href="${SITE_URL}" style="display:inline-block;background:${BTN_COLOR};color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:bold;">לכל המוצרים באתר השלל החם ברשת »</a>` +
    `</div>` +
    banner +
    productsHtml +
    `<div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;text-align:center;">` +
    `<a href="${SIGNUP_URL}" style="display:inline-block;background:${BTN_COLOR};color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:bold;margin-bottom:16px;">הצטרפות לרשימת התפוצה</a>` +
    `</div></body></html>`;
}

function generateAndUploadPdf(htmlContent) {
  return new Promise((resolve, reject) => {
    // Use script directory as temp location (avoids Hebrew chars in %TEMP% path)
    const tmpHtml = path.join(__dirname, `tmp_email_${Date.now()}.html`);
    fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

    const scriptPath = path.join(__dirname, 'html_to_pdf_upload.py');
    execFile('python', [scriptPath, tmpHtml], { timeout: 120000 }, (err, stdout, stderr) => {
      fs.unlink(tmpHtml, () => {});
      if (err) {
        console.error('PDF generation error:', stderr);
        return reject(err);
      }
      const url = stdout.trim();
      if (!url.startsWith('http')) {
        return reject(new Error('Bad PDF URL: ' + url));
      }
      resolve(url);
    });
  });
}

function isYomTovToday() {
  // Israel timezone
  const israelNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const y = israelNow.getUTCFullYear();
  const m = String(israelNow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(israelNow.getUTCDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;
  const url = `/hebcal?cfg=json&v=1&maj=on&i=on&start=${today}&end=${today}`;

  return new Promise((resolve) => {
    https.get({ hostname: 'www.hebcal.com', path: url }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const items = (JSON.parse(data).items) || [];
          // Skip real Yom Tov days, plus Tish'a B'Av — a fast (yomtov=false in Hebcal)
          // that Meirav wants email-free. Regex skips "Erev Tish'a B'Av" and tolerates
          // Hebcal's curly apostrophes and "(observed)" variants.
          const yt = items.find(it => it.yomtov === true || /^Tish.a B.Av/.test(it.title));
          resolve(yt ? yt.title : null);
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function run() {
  // Skip evening sends after cashback promo ends (single daily send post-promo)
  const israelNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const todayIL = israelNow.toISOString().split('T')[0];
  const hourIL = israelNow.getUTCHours();
  if (!TEST_EMAIL && todayIL > CASHBACK_END && hourIL >= 18) {
    console.log(`המבצע הסתיים והשעה ${hourIL}:xx — מדלגים על שליחת ערב. יציאה.`);
    return;
  }

  // Check for Yom Tov (Israeli observance) and skip if today
  const yomTov = TEST_EMAIL ? null : await isYomTovToday();
  if (yomTov) {
    console.log(`היום ${yomTov} — לא שולחים. יציאה.`);
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) console.error('חסרים SUPABASE_URL או SUPABASE_SECRET_KEY: התמונות יישארו קישורי Airtable זמניים');
  else await cleanupOldMedia();

  // Pin window: include specific products first in every send from..until (inclusive, order = display order)
  const PIN_WINDOW = { from: '2026-11-12', until: '2026-11-12', evening: false, ids: ['recE2DxkMn6WFNm3Q'] };
  const shouldPin = todayIL >= PIN_WINDOW.from && todayIL <= PIN_WINDOW.until && (PIN_WINDOW.evening ? isEveningRun() : !isEveningRun());

  // 1. Fetch Airtable records
  console.log('שולף מוצרים מ-Airtable...');
  const pinCount = shouldPin ? PIN_WINDOW.ids.length : 0;
  const regularMax = 18 - pinCount;
  const qs = new URLSearchParams({
    filterByFormula: RESEND_DATE ? `IS_SAME({תאריך שליחה במייל},"${RESEND_DATE}","day")` : filterFormula,
    'sort[0][field]': 'תאריך עדכון אחרון ',
    'sort[0][direction]': 'asc',
    maxRecords: String(regularMax)
  });

  let records = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const airtableRes = await httpsRequest({
      hostname: 'api.airtable.com',
      path: `/v0/app0Y6aG3mPGuZZTI/tblGHPMhXKU7wQz6j?${qs}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });
    records = airtableRes.body.records || [];
    if (records.length > 0) break;
    console.log(`ניסיון ${attempt}: 0 רשומות. ${attempt < 3 ? 'מנסה שוב בעוד 3 שניות...' : ''}`);
    if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
  }

  if (shouldPin) {
    const pinnedRecs = [];
    for (const id of PIN_WINDOW.ids) {
      const pinRes = await httpsRequest({
        hostname: 'api.airtable.com',
        path: `/v0/app0Y6aG3mPGuZZTI/tblGHPMhXKU7wQz6j/${id}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
      });
      if (pinRes.body && pinRes.body.id) {
        pinnedRecs.push(pinRes.body);
        console.log(`Pinned: ${pinRes.body.fields['קוד מוצר']}`);
      }
    }
    records = [...pinnedRecs, ...records.filter(r => !PIN_WINDOW.ids.includes(r.id))];
  }

  console.log(`נמצאו ${records.length} מוצרים`);

  if (records.length === 0) {
    console.log('אין מוצרים לשליחה. יציאה.');
    return;
  }

  // 2. Upload images to smoove for permanent URLs
  const urlMap = await uploadRecordImages(records);

  // 3. Build email HTML (full images for email)
  const productsHtml = records.map(r => buildProductHtml(r, urlMap)).join('');
  const emailBody = buildEmailHtml(productsHtml);

  // 4. Generate PDF — compact version (2 images per product to stay under 10MB)
  console.log('יוצר PDF ומעלה...');
  const pdfProductsHtml = records.map(r => buildProductHtml(r, urlMap, { maxFeedback: 1, maxWp: 1 })).join('');
  const pdfHtml = buildEmailHtml(pdfProductsHtml);
  let pdfUrl = null;
  try {
    pdfUrl = await generateAndUploadPdf(pdfHtml);
    console.log('PDF URL:', pdfUrl);
  } catch (e) {
    console.error('נכשל ביצירת PDF:', e.message);
    // Continue without attachment
  }

  // 5. Create smoove campaign
  console.log('יוצר קמפיין ב-smoove...');
  const campaignData = {
    name: `השלל החם ברשת - ${today}`,
    toListsById: [833622],
    subject: currentSubject(),
    body: emailBody,
    customFromAddress: 'shalal.buy4you.co.il@send.vpcontact.com',
    // Without this, smoove defaults Reply-To to customFromAddress (the send-only
    // vpcontact address, which silently drops every reply). Route replies to the
    // real inbox: shalal@buy4you.co.il -> Cloudflare -> shalal.buy4you@gmail.com.
    customReplyToAddress: 'shalal@buy4you.co.il'
  };
  if (TEST_EMAIL) {
    delete campaignData.toListsById;
    campaignData.toMembersByEmail = [TEST_EMAIL];
    campaignData.name = `בדיקה - ${campaignData.name}`;
    campaignData.subject = `[בדיקה] ${campaignData.subject}`;
    console.log(`מצב בדיקה: נשלח רק אל ${TEST_EMAIL}`);
  }
  if (pdfUrl) {
    campaignData.campaignAttachments = [pdfUrl];
  }

  const campaignPayload = JSON.stringify(campaignData);
  const createRes = await httpsRequest({
    hostname: 'rest.smoove.io',
    path: '/v1/Campaigns',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SMOOVE_TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(campaignPayload)
    }
  }, campaignPayload);

  console.log('יצירת קמפיין status:', createRes.status);

  const campaignId = createRes.body && createRes.body.id;
  if (!campaignId) {
    console.error('שגיאה ביצירת קמפיין:', JSON.stringify(createRes.body).substring(0, 300));
    return;
  }
  console.log('Campaign ID:', campaignId);

  // 6. Send campaign (retry up to 3 times on failure)
  console.log('שולח קמפיין...');
  const sendPayload = '{}';
  let sendRes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    sendRes = await httpsRequest({
      hostname: 'rest.smoove.io',
      path: `/v1/Campaigns/${campaignId}/send`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SMOOVE_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(sendPayload)
      }
    }, sendPayload);
    console.log(`שליחה ניסיון ${attempt}: status ${sendRes.status}, ${JSON.stringify(sendRes.body).substring(0, 100)}`);
    if (sendRes.status >= 200 && sendRes.status < 300) break;
    if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
  }

  if (sendRes.status < 200 || sendRes.status >= 300) {
    console.error('❌ שליחת קמפיין נכשלה אחרי 3 ניסיונות. לא מעדכן Airtable.');
    return;
  }

  if (TEST_EMAIL) {
    console.log(`
✅ מייל בדיקה נשלח אל ${TEST_EMAIL}. Airtable לא עודכן.`);
    return;
  }

  if (RESEND_DATE) {
    console.log(`
✅ שליחה חוזרת של המייל מ-${RESEND_DATE} הושלמה. Airtable לא עודכן.`);
    return;
  }

  // 7. Update Airtable — set send date
  console.log('מעדכן תאריך שליחה ב-Airtable...');
  for (const record of records) {
    const patchPayload = JSON.stringify({ fields: { 'תאריך שליחה במייל': today } });
    const patchRes = await httpsRequest({
      hostname: 'api.airtable.com',
      path: `/v0/app0Y6aG3mPGuZZTI/tblGHPMhXKU7wQz6j/${record.id}`,
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(patchPayload)
      }
    }, patchPayload);
    const code = record.fields['קוד מוצר'] || record.id;
    console.log(`  ${code}: ${patchRes.status}`);
  }

  console.log('\n✅ הושלם! המייל נשלח לרשימה' + (pdfUrl ? ' עם PDF מצורף.' : ' ללא PDF.'));
}

run().catch(console.error);
