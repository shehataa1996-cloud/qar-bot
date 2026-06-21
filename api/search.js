// =================================================================
// api/search.js
// -----------------------------------------------------------------
// الوظيفة:
// 1) ياخذ طلب المستخدم بالعربي (مثال: "ابحث لي عن أرض في حي الياسمين مساحة 500 متر")
// 2) يبعته لـ Groq (مجاني) عشان يحوله لفلاتر بحث منظمة (JSON)
// 3) يبني رابط بحث على موقع عقار (aqar.fm) ويجرب أكثر من رابط محتمل
//    (لأن عقار يحتاج "المنطقة" داخل الرابط مثل: شمال الرياض / جنوب الرياض...)
// 4) يسحب صفحة النتائج (HTML) ويستخرج منها: السعر، المساحة، الجوال، رقم الإعلان
// 5) يرجع كل شي كـ JSON منظم للواجهة الأمامية (index.html)
//
// ملاحظة مهمة: عقار.فم ما عندها API رسمي، فهذا "سحب بيانات" (scraping) لصفحات
// عامة (مش محمية بكلمة سر)، ولازم تحترم حدود الاستخدام العادلة (ما تطلب آلاف
// الطلبات بالدقيقة). هذا الكود مبني للاستخدام الشخصي/الخفيف.
// =================================================================

import dotenv from "dotenv";
import * as cheerio from "cheerio";

dotenv.config();

// -----------------------------------------------------------------
// 1) خريطة: نوع العقار + نوع العملية (بيع/إيجار) -> اسم الفئة في رابط عقار
// -----------------------------------------------------------------
const SLUG_MAP = {
  "أرض_بيع": "أراضي-للبيع",
  "أرض_إيجار": "أراضي-للإيجار",
  "شقة_بيع": "شقق-للبيع",
  "شقة_إيجار": "شقق-للإيجار",
  "فيلا_بيع": "فلل-للبيع",
  "فيلا_إيجار": "فلل-للإيجار",
  "دور_بيع": "دور-للبيع",
  "دور_إيجار": "دور-للإيجار",
  "عمارة_بيع": "عمائر-للبيع",
  "عمارة_إيجار": "عمائر-للإيجار",
  "محل_بيع": "محلات-للبيع",
  "محل_إيجار": "محلات-للإيجار",
  "استراحة_بيع": "استراحة-للبيع",
  "استراحة_إيجار": "استراحة-للإيجار",
  "مزرعة_بيع": "مزرعة-للبيع",
  "مزرعة_إيجار": "مزارع-للإيجار",
  "مكتب_إيجار": "مكتب-تجاري-للإيجار",
  "غرفة_بيع": "غرف-للبيع",
  "غرفة_إيجار": "غرف-للإيجار",
  "مستودع_إيجار": "مستودع-للإيجار",
  "مستودع_بيع": "مستودعات-للبيع",
  "شاليه_إيجار": "شاليه-للإيجار",
  "فندق_بيع": "فنادق-للبيع",
  "فندق_إيجار": "فنادق-للإيجار",
  "مدرسة_بيع": "مدارس-للبيع",
  "مدرسة_إيجار": "مدارس-للإيجار",
};

// مناطق الرياض الخمسة المعروفة لدى عقار. نجرب كل واحدة لأننا ما نعرف
// مسبقاً أي منطقة يتبعها الحي المطلوب.
const RIYADH_REGIONS = [
  "شمال-الرياض",
  "جنوب-الرياض",
  "شرق-الرياض",
  "غرب-الرياض",
  "وسط-الرياض",
];

// -----------------------------------------------------------------
// 2) استدعاء Groq لتحويل النص العربي الحر إلى فلاتر منظمة
// -----------------------------------------------------------------
async function parseQueryWithGroq(userMessage) {
  const systemPrompt = `أنت محلل طلبات عقارية سعودية. حوّل طلب المستخدم إلى JSON فقط بدون أي نص أو شرح أو علامات backticks.
الحقول المطلوبة بالضبط:
{
  "city": "اسم المدينة بالعربي بدون كلمة مدينة (افتراضي: الرياض)",
  "district": "اسم الحي فقط بدون كلمة حي، مثال: الياسمين",
  "listingType": "بيع" أو "إيجار",
  "propertyType": واحد فقط من هذه القائمة: ["أرض","شقة","فيلا","دور","عمارة","محل","استراحة","مزرعة","مكتب","غرفة","مستودع","شاليه","فندق","مدرسة","عقار"],
  "area": رقم المساحة المطلوبة بالمتر، أو null إذا غير مذكورة,
  "maxPrice": أعلى سعر مذكور، أو null إذا غير مذكور
}
إذا لم يحدد المستخدم نوع العملية افترض "بيع". إذا لم يحدد نوع العقار استخدم "عقار".
أعد فقط كائن JSON صحيح، بدون أي كلام إضافي.`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b", // موديل Groq المجاني الحالي (سريع وذكي)
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`فشل الاتصال بـ Groq: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  let raw = data.choices?.[0]?.message?.content?.trim() || "{}";

  // تنظيف احتياطي لو رجع الموديل النص داخل ```json ... ```
  raw = raw.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("تعذر فهم الرد من Groq كـ JSON صالح");
  }
}

// -----------------------------------------------------------------
// 3) بناء كل الروابط المحتملة لتجربتها على aqar.fm
// -----------------------------------------------------------------
function buildCandidateUrls({ city, district, categorySlug }) {
  const normalizedCity = city?.trim() || "الرياض";
  const districtSlug = district
    ? `حي-${district.replace(/^حي[\s-]*/, "").trim()}`
    : null;

  const encode = (parts) =>
    "https://sa.aqar.fm/" + parts.map((p) => encodeURIComponent(p)).join("/");

  const candidates = [];

  if (normalizedCity === "الرياض" && districtSlug) {
    // أول 5 محاولات: نفس الفئة + كل منطقة من مناطق الرياض + الحي
    for (const region of RIYADH_REGIONS) {
      candidates.push(encode([categorySlug, normalizedCity, region, districtSlug]));
    }
  }

  // محاولة بدون منطقة (فئة + مدينة + حي مباشرة)
  if (districtSlug) {
    candidates.push(encode([categorySlug, normalizedCity, districtSlug]));
  }

  // محاولة أوسع: فئة + مدينة فقط (بدون حي محدد)
  candidates.push(encode([categorySlug, normalizedCity]));

  return candidates;
}

// -----------------------------------------------------------------
// 4) سحب صفحة وتحليلها لاستخراج بطاقات الإعلانات
// -----------------------------------------------------------------
const PHONE_REGEX = /(?:\+?966|0)?5\d(?:[\s-]?\d){7}/g;
const AD_LINK_REGEX = /^(?:https?:\/\/sa\.aqar\.fm)?\/?[^/]+\/.+-(\d{5,8})$/;

function toEnglishDigits(text) {
  if (!text) return text;
  return text.replace(/[٠١٢٣٤٥٦٧٨٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

function normalizeHref(href) {
  try {
    return new URL(href, "https://sa.aqar.fm").toString();
  } catch {
    return null;
  }
}

function normalizePhone(raw) {
  let digits = raw.replace(/[\s-]/g, "");
  if (digits.startsWith("+966")) digits = "0" + digits.slice(4);
  else if (digits.startsWith("966")) digits = "0" + digits.slice(3);
  else if (!digits.startsWith("0")) digits = "0" + digits;
  return digits;
}

async function fetchAndParse(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "ar,en;q=0.8",
    },
  });

  if (!res.ok) return { listings: [], status: res.status };

  const html = await res.text();
  const $ = cheerio.load(html);
  const listings = [];
  const seenLinks = new Set();

  $("a[href]").each((_, el) => {
    const rawHref = $(el).attr("href");
    const href = normalizeHref(rawHref);
    if (!href || !AD_LINK_REGEX.test(href)) return;
    if (seenLinks.has(href)) return;
    seenLinks.add(href);

    const adIdMatch = href.match(AD_LINK_REGEX);
    const adId = adIdMatch ? adIdMatch[1] : null;

    const rawText = $(el).text().replace(/\s+/g, " ").trim();
    const fullText = toEnglishDigits(rawText);
    const image = $(el).find("img").first().attr("src") || null;

    // السعر: أول رقم متبوع برمز الريال ﷼
    const priceMatch = fullText.match(/([\d,]{3,12})\s*﷼/);
    const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null;

    // المساحة: رقم متبوع بـ م² (متر مربع)
    const areaMatch = fullText.match(/([\d,]+)\s*م²/);
    const area = areaMatch ? Number(areaMatch[1].replace(/,/g, "")) : null;

    // عرض الشارع: رقم متبوع بحرف م لوحده (بدون ²) بعد المساحة
    const streetMatch = fullText.match(/م²\D*?(\d{1,3})م(?!²)/);
    const streetWidth = streetMatch ? Number(streetMatch[1]) : null;

    // النوع: سكني / تجاري لو موجود
    const typeMatch = fullText.match(/(سكني|تجاري)/);
    const propertyTag = typeMatch ? typeMatch[1] : null;

    // العنوان التقريبي: النص قبل أول رقم سعر
    const title = priceMatch
      ? fullText.slice(0, fullText.indexOf(priceMatch[0])).trim()
      : fullText.slice(0, 80).trim();

    // رقم الجوال لو مذكور داخل نص الإعلان
    const phoneMatches = fullText.match(PHONE_REGEX) || [];
    const phone = phoneMatches.length ? normalizePhone(phoneMatches[0]) : null;

    listings.push({
      adId,
      link: href,
      image,
      title,
      price,
      area,
      streetWidth,
      propertyTag,
      phone,
      phoneLink: phone ? `tel:${phone}` : null,
      whatsappLink: phone ? `https://wa.me/966${phone.slice(1)}` : null,
      snippet: rawText.slice(0, 400),
    });
  });

  return { listings, status: res.status };
}

// -----------------------------------------------------------------
// 5) الدالة الرئيسية (Vercel Serverless Function)
// -----------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "استخدم POST فقط" });
  }

  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ success: false, error: "أرسل { message: '...' }" });
    }

    // 1) فهم الطلب عبر Groq
    const filters = await parseQueryWithGroq(message);

    const propertyType = filters.propertyType || "عقار";
    const listingType = filters.listingType || "بيع";
    const categorySlug =
      SLUG_MAP[`${propertyType}_${listingType}`] || "عقارات";

    // 2) بناء كل الروابط المحتملة وتجربتها بالتوازي
    const candidateUrls = buildCandidateUrls({
      city: filters.city,
      district: filters.district,
      categorySlug,
    });

    let winningUrl = null;
    let listings = [];

    for (const url of candidateUrls) {
      const result = await fetchAndParse(url);
      if (result.listings.length > 0) {
        winningUrl = url;
        listings = result.listings;
        break; // أول رابط نجح نوقف عنده
      }
    }

    // 3) فلترة حسب المساحة المطلوبة لو محددة (بتفاوت ±20%)
    if (filters.area && listings.length > 0) {
      const target = Number(filters.area);
      const tolerance = target * 0.2;
      const filtered = listings
        .filter((l) => l.area && Math.abs(l.area - target) <= tolerance)
        .sort((a, b) => Math.abs(a.area - target) - Math.abs(b.area - target));
      // لو الفلترة رجعت نتائج، نستخدمها. لو ما رجعت شي، نعرض كل النتائج
      // عشان ما يضيع البحث بالكامل (الأقرب أفضل من لا شي).
      if (filtered.length > 0) listings = filtered;
    }

    return res.status(200).json({
      success: true,
      filters,
      sourceUrl: winningUrl,
      count: listings.length,
      listings: listings.slice(0, 20),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message || "خطأ غير متوقع" });
  }
}
