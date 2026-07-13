const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const SMOOVE_TOKEN = process.env.SMOOVE_TOKEN;

// Cutoff is 2026-06-04 10:00 UTC (13:00 Israel), NOT an arbitrary date. On 2026-06-04
// the Airtable image compression touched the "פידבקים תמונה" field on 289 old records,
// which bumped their computed תאריך עדכון אחרון to ~09:27-09:28 UTC and shoved ~25
// never-sent 2023-2024 products to the front of the daily queue. This cutoff sits after
// that bump window and before the first genuine post-compression edit (12:44 UTC), so the
// queue starts from real new products. Editing any old product re-bumps it past the
// cutoff and brings it back into rotation automatically.
const filterFormula = `AND(NOT({קוד מוצר}="סטוריז"),NOT(SEARCH("פספוסי קניות",{קוד מוצר})),NOT(SEARCH("שבוע טוב",{קוד מוצר})),IS_AFTER({תאריך עדכון אחרון },"2026-06-04T10:00:00.000Z"),OR(NOT({תאריך שליחה במייל}),IS_BEFORE({תאריך שליחה במייל},{תאריך עדכון אחרון })))`;

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

const smooveUrlCache = new Map();

async function uploadImageToSmoove(airtableUrl) {
  if (smooveUrlCache.has(airtableUrl)) return smooveUrlCache.get(airtableUrl);
  try {
    const imageData = await downloadBuffer(airtableUrl);
    const boundary = '----Boundary' + Date.now();
    const ext = airtableUrl.split('?')[0].split('.').pop().toLowerCase() || 'jpg';
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    const filename = `img_${Date.now()}.${ext}`;
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, imageData, footer]);

    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'studio-api.admin.smoove.io',
        path: '/upload',
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
      }, (r) => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const json = JSON.parse(res);
    const smooveUrl = json.fileUrl;
    smooveUrlCache.set(airtableUrl, smooveUrl);
    return smooveUrl;
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
const BTN_COLOR  = '#D4746E';
const CASHBACK_URL = 'https://s.click.aliexpress.com/e/_c3cNkFs1';
const CASHBACK_END = '2026-06-10'; // promo ends June 10 at midnight (last send: June 10)
const CASHBACK_SUBJECT_MORNING = '🔥 התחיל מבצע קאשבק! 10 ימים של מוצרים חמים + כסף חזרה';
const CASHBACK_SUBJECT_EVENING = '🌙 עוד מוצרים שווים לערב + קאשבק על כל קנייה';
const REGULAR_SUBJECT = '🔥 השלל החם ברשת - מוצרים של היום';
// One-shot subject suffix: appended to the subject only on this Israel date
const SUBJECT_ONCE = { date: '2026-07-13', suffix: ' + סייל חדש וקופונים שווים' };

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
  const base = isCashbackPromoActive()
    ? (isEveningRun() ? CASHBACK_SUBJECT_EVENING : CASHBACK_SUBJECT_MORNING)
    : REGULAR_SUBJECT;
  const todayIL = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().split('T')[0];
  return todayIL === SUBJECT_ONCE.date ? base + SUBJECT_ONCE.suffix : base;
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
    `<img src="${LOGO_URL}" style="max-width:280px;width:100%;border-radius:12px;display:block;margin:0 auto 14px;" />` +
    `<p style="font-size:18px;font-weight:bold;color:#222;margin:0;">✨ הפריטים הכי שווים ברשת ✨</p>` +
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
          const yt = items.find(it => it.yomtov === true);
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
  if (todayIL > CASHBACK_END && hourIL >= 18) {
    console.log(`המבצע הסתיים והשעה ${hourIL}:xx — מדלגים על שליחת ערב. יציאה.`);
    return;
  }

  // Check for Yom Tov (Israeli observance) and skip if today
  const yomTov = await isYomTovToday();
  if (yomTov) {
    console.log(`היום ${yomTov} — לא שולחים. יציאה.`);
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  // One-shot pin: include specific products in a specific send (order = display order)
  const PIN_ONCE = { date: '2026-07-13', evening: false, ids: ['recsTcPwq2YzXc2Xd'] };
  const shouldPin = todayIL === PIN_ONCE.date && (PIN_ONCE.evening ? isEveningRun() : !isEveningRun());

  // 1. Fetch Airtable records
  console.log('שולף מוצרים מ-Airtable...');
  const pinCount = shouldPin ? PIN_ONCE.ids.length : 0;
  const regularMax = 18 - pinCount;
  const qs = new URLSearchParams({
    filterByFormula: filterFormula,
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
    for (const id of PIN_ONCE.ids) {
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
    records = [...pinnedRecs, ...records.filter(r => !PIN_ONCE.ids.includes(r.id))];
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
