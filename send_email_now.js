const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const AIRTABLE_TOKEN = 'REDACTED-AIRTABLE-TOKEN';
const SMOOVE_TOKEN = 'REDACTED-SMOOVE-TOKEN';

const filterFormula = `AND(NOT({קוד מוצר}="סטוריז"),IS_AFTER({תאריך עדכון אחרון },"2026-04-20"),OR(NOT({תאריך שליחה במייל}),IS_BEFORE({תאריך שליחה במייל},{תאריך עדכון אחרון })))`;

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

function imgTag(url) {
  return `<img src="${url}" style="max-width:560px;width:100%;display:block;margin-bottom:8px;border-radius:8px;" />`;
}

function buildProductHtml(record, { maxFeedback = 3, maxWp = 6 } = {}) {
  const f = record.fields;
  const feedbackImgs = f['פידבקים תמונה '] || [];
  const wpImgs = f['תמונות לוואטסאפ'] || [];
  const description = (f['תיאור'] || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  let html = `<div dir="rtl" style="margin-bottom:28px;padding-bottom:28px;border-bottom:2px solid #f0f0f0;font-family:Arial,sans-serif;">`;
  for (const img of feedbackImgs.slice(0, maxFeedback)) if (img.url) html += imgTag(img.url);
  for (const img of wpImgs.slice(0, maxWp)) if (img.url) html += imgTag(img.url);
  html += `<p style="white-space:pre-line;font-size:14px;line-height:1.7;color:#333;margin:12px 0 0;">${description}</p>`;
  html += `</div>`;
  return html;
}

const LOGO_URL   = 'https://content.vp4.me/shalal/Content/IMG_20230226_200201_169_590x590-r.jpg';
const SIGNUP_URL = 'https://lp.vp4.me/oyz4';
const BTN_COLOR  = '#D4746E';
const UNSUB_URL  = 'https://portal.smoove.io/fg8sibajnajf9k8n5fnf/profile/unsubscribe';

function buildEmailHtml(productsHtml) {
  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="UTF-8"/></head>` +
    `<body style="font-family:Arial,sans-serif;direction:rtl;text-align:right;max-width:600px;margin:0 auto;padding:20px;background:#fff;">` +
    `<div style="text-align:center;margin-bottom:24px;">` +
    `<img src="${LOGO_URL}" style="max-width:280px;width:100%;border-radius:12px;display:block;margin:0 auto 14px;" />` +
    `<p style="font-size:18px;font-weight:bold;color:#222;margin:0;">✨ הפריטים הכי שווים ברשת ✨</p>` +
    `</div>` +
    productsHtml +
    `<div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;text-align:center;">` +
    `<a href="${SIGNUP_URL}" style="display:inline-block;background:${BTN_COLOR};color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:bold;margin-bottom:16px;">הצטרפות לרשימת התפוצה</a>` +
    `<br/>` +
    `<a href="${UNSUB_URL}" style="color:#aaa;font-size:12px;text-decoration:underline;">הסר אותי מהרשימה</a>` +
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

async function run() {
  const today = new Date().toISOString().split('T')[0];

  // 1. Fetch Airtable records
  console.log('שולף מוצרים מ-Airtable...');
  const qs = new URLSearchParams({
    filterByFormula: filterFormula,
    'sort[0][field]': 'תאריך עדכון אחרון ',
    'sort[0][direction]': 'asc',
    maxRecords: '12'
  });

  const airtableRes = await httpsRequest({
    hostname: 'api.airtable.com',
    path: `/v0/app0Y6aG3mPGuZZTI/tblGHPMhXKU7wQz6j?${qs}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
  });

  const records = airtableRes.body.records || [];
  console.log(`נמצאו ${records.length} מוצרים`);

  if (records.length === 0) {
    console.log('אין מוצרים לשליחה. יציאה.');
    return;
  }

  // 2. Build email HTML (full images for email)
  const productsHtml = records.map(r => buildProductHtml(r)).join('');
  const emailBody = buildEmailHtml(productsHtml);

  // 3. Generate PDF — compact version (2 images per product to stay under 10MB)
  console.log('יוצר PDF ומעלה...');
  const pdfProductsHtml = records.map(r => buildProductHtml(r, { maxFeedback: 1, maxWp: 1 })).join('');
  const pdfHtml = buildEmailHtml(pdfProductsHtml);
  let pdfUrl = null;
  try {
    pdfUrl = await generateAndUploadPdf(pdfHtml);
    console.log('PDF URL:', pdfUrl);
  } catch (e) {
    console.error('נכשל ביצירת PDF:', e.message);
    // Continue without attachment
  }

  // 4. Create smoove campaign
  console.log('יוצר קמפיין ב-smoove...');
  const campaignData = {
    name: `השלל החם ברשת - ${today}`,
    toMembersByEmail: ['meirav309@gmail.com'],
    subject: '🔥 השלל החם ברשת - מוצרים של היום',
    body: emailBody
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

  // 5. Send campaign
  console.log('שולח קמפיין...');
  const sendPayload = '{}';
  const sendRes = await httpsRequest({
    hostname: 'rest.smoove.io',
    path: `/v1/Campaigns/${campaignId}/send`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SMOOVE_TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(sendPayload)
    }
  }, sendPayload);

  console.log('שליחה status:', sendRes.status, JSON.stringify(sendRes.body).substring(0, 200));

  // 6. Update Airtable — set send date
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
