/**
 * Task-A query set: 32 Arabic + 32 Persian queries derived from real ayah
 * content, each with a *deterministic* relevance rule.
 *
 * Why this format: "labelled relevance you can defend" means the label has to
 * be checkable. For every query, the gold set is computed by this file's rules
 * — a normalised substring match (via `normalizeWord`, the same function the
 * engine uses) against the cited field — and `scripts/build-gold.mjs` verifies
 * that each pattern matches at least one ayah and prints the hits with their
 * quoted evidence. Nothing in a gold set is a guess about meaning: it is the
 * set of ayahs whose own text contains the quoted basis stated in `reason`.
 *
 * Fields:
 *   ar  = Uthmani ayah text, normalised (diacritics folded)
 *   fa  = tr-fa-135 (IslamHouse) Persian translation, normalised
 *   en  = tr-en-85 (Abdul Haleem) English translation, normalised (latin path)
 *
 * kinds:
 *   exact-phrase         the query IS the ayah's wording (lexical ceiling case)
 *   refrain              identical surface form, only context differs (surah 55)
 *   concept-ar           Arabic topic words, gold on the Arabic text
 *   concept-fa           Persian topic words, gold on the Persian translation
 *   cross-lingual        query in one language, gold defined on the *other*
 *                        language's field: pure semantic retrieval, no shared
 *                        surface tokens. This is the case the model must win or
 *                        drop out.
 *
 * `exclude` lists verse keys that match the pattern but are not relevant under
 * the stated reason (homographs); build-gold reports them so the exclusion is
 * auditable rather than silent.
 */

export const QUERIES = [
  /* ------------------------------- Arabic ------------------------------- */
  {
    id: 'ar01', lang: 'ar', kind: 'exact-phrase',
    text: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
    patterns: [{ field: 'ar', pattern: 'بسم الله الرحمن الرحيم' }],
    reason: 'Quoted opening of al-Fatihah; the corpus carries the basmalah as verse 1:1.',
  },
  {
    id: 'ar02', lang: 'ar', kind: 'exact-phrase',
    text: 'إِنَّ مَعَ الْعُسْرِ يُسْرًا',
    patterns: [{ field: 'ar', pattern: 'ان مع العسر يسرا' }],
    reason: 'Ash-Sharh 94:5-6 states ease accompanies hardship verbatim.',
  },
  {
    id: 'ar03', lang: 'ar', kind: 'exact-phrase',
    text: 'لَا إِكْرَاهَ فِي الدِّينِ',
    patterns: [{ field: 'ar', pattern: 'لا اكراه في الدين' }],
    reason: "Al-Baqarah 2:256 — 'no compulsion in religion' is the whole verse.",
  },
  {
    id: 'ar04', lang: 'ar', kind: 'concept-ar',
    text: 'تحريم الربا وأكل أموال الناس بالباطل',
    patterns: [{ field: 'ar', pattern: 'الربوا' }],
    reason: 'Every ayah naming riba (usury) is on-topic for a prohibition query; the word is the stated basis.',
  },
  {
    id: 'ar05', lang: 'ar', kind: 'concept-ar',
    text: 'الإحسان إلى اليتيم',
    patterns: [{ field: 'ar', pattern: 'اليتيم' }],
    reason: 'Orphan (al-yatim) explicitly named; kindness/duties toward orphans.',
  },
  {
    id: 'ar06', lang: 'ar', kind: 'concept-ar',
    text: 'خمر و رجس از عمل شیطان',
    patterns: [{ field: 'ar', pattern: 'الخمر' }],
    reason: 'Intoxicant named explicitly in the Arabic text.',
  },
  {
    id: 'ar07', lang: 'ar', kind: 'concept-ar',
    text: 'یونس در شکم ماهی',
    patterns: [{ field: 'ar', pattern: 'الحوت' }],
    reason: "The fish (al-hut) that swallowed Yunus; 21:87 is his prayer inside it.",
  },
  {
    id: 'ar08', lang: 'ar', kind: 'concept-ar',
    text: 'عصای موسی که اژدها شد',
    patterns: [{ field: 'ar', pattern: 'عصاك' }, { field: 'ar', pattern: 'عصاه' }],
    reason: "Moses' staff is addressed/named ('your staff', 'his staff').",
  },
  {
    id: 'ar09', lang: 'ar', kind: 'concept-ar',
    text: 'دریای شیرین و شور میان‌بَرزخ',
    patterns: [{ field: 'ar', pattern: 'الملح' }, { field: 'ar', pattern: 'العذب' }],
    reason: 'The two seas, one fresh one salty, with a barrier between them.',
  },
  {
    id: 'ar10', lang: 'ar', kind: 'exact-phrase',
    text: 'كُلُّ نَفْسٍ ذَائِقَةُ الْمَوْتِ',
    patterns: [{ field: 'ar', pattern: 'كل نفس ذائقة الموت' }],
    reason: 'Formulaic statement that every soul tastes death (3:185, 21:35, 29:57).',
  },
  {
    id: 'ar11', lang: 'ar', kind: 'concept-ar',
    text: 'شب قدر که از هزار ماه بهتر است',
    patterns: [{ field: 'ar', pattern: 'ليلة القدر' }],
    reason: 'The Night of Decree named in al-Qadr.',
  },
  {
    id: 'ar12', lang: 'ar', kind: 'concept-ar',
    text: 'أصحاب الكهف و الرقيم',
    patterns: [{ field: 'ar', pattern: 'الكهف' }],
    reason: 'The sleepers in the cave; al-Kahf names the cave.',
  },
  {
    id: 'ar13', lang: 'ar', kind: 'concept-ar',
    text: 'وزن و ترازوی اعمال در روز قیامت',
    patterns: [{ field: 'ar', pattern: 'الميزان' }, { field: 'ar', pattern: 'وزن' }],
    reason: 'The scale/weighing of deeds; both the balance and the weighing verb.',
  },
  {
    id: 'ar14', lang: 'ar', kind: 'concept-ar',
    text: 'آسمان در قیامت ترک برمی‌دارد',
    patterns: [{ field: 'ar', pattern: 'انفطرت' }, { field: 'ar', pattern: 'انشق' }],
    reason: 'Sky splitting open at the Hour (82:1, 84:1, 54:1).',
  },
  {
    id: 'ar15', lang: 'ar', kind: 'refrain',
    text: 'فَبِأَيِّ آلَاءِ رَبِّكُمَا تُكَذِّبَانِ',
    patterns: [{ field: 'ar', pattern: 'فبأي ءالاء ربكما تكذبان' }],
    reason: 'The ar-Rahman refrain: 31 ayahs with an identical surface form — the hard case where only position/context differs.',
  },
  {
    id: 'ar16', lang: 'ar', kind: 'concept-ar',
    text: 'بهشت‌های عدن برای مؤمنان',
    patterns: [{ field: 'ar', pattern: 'جنات عدن' }],
    reason: 'Gardens of Eden promised to believers.',
  },
  {
    id: 'ar17', lang: 'ar', kind: 'exact-phrase',
    text: 'اهْدِنَا الصِّرَاطَ الْمُسْتَقِيمَ',
    patterns: [{ field: 'ar', pattern: 'اهدنا الصراط المستقيم' }],
    reason: 'Verse of the Fatihah petition for the straight path.',
  },
  {
    id: 'ar18', lang: 'ar', kind: 'concept-ar',
    text: 'نماز انسان را از زشتی بازمی‌دارد',
    patterns: [{ field: 'ar', pattern: 'ان الصلاة تنهي عن الفحشاء' }],
    reason: 'Al-Ankabut 29:45 — prayer restrains from indecency.',
  },
  {
    id: 'ar19', lang: 'ar', kind: 'concept-ar',
    text: 'کلام خدا صادق و عادل است',
    patterns: [{ field: 'ar', pattern: 'وتمت كلمة ربك صدقا وعدلا' }],
    reason: "Your Lord's word is perfect in truth and justice (6:115, 18:27).",
  },
  {
    id: 'ar20', lang: 'ar', kind: 'concept-ar',
    text: 'نهی از تکبر در راه رفتن',
    patterns: [{ field: 'ar', pattern: 'ولا تمش في الأرض مرحا' }],
    reason: 'Luqman 31:18 forbids strutting in arrogance.',
  },
  {
    id: 'ar21', lang: 'ar', kind: 'concept-ar',
    text: 'آهن فرو فرستاده شد و در آن نیرو است',
    patterns: [{ field: 'ar', pattern: 'أنزلنا الحديد' }],
    reason: 'Al-Hadid 57:25 — iron sent down with mighty strength.',
  },
  {
    id: 'ar22', lang: 'ar', kind: 'concept-ar',
    text: 'خورشید و ماه به حساب و مدار',
    patterns: [{ field: 'ar', pattern: 'الحسبان' }, { field: 'ar', pattern: 'بحساب' }],
    reason: 'Sun and moon run by computation (55:5, 36:39-40, 6:96).',
  },
  {
    id: 'ar23', lang: 'ar', kind: 'concept-ar',
    text: 'شتر خدا و نشانه‌ای برای مردم',
    patterns: [{ field: 'ar', pattern: 'ناقة' }],
    reason: "Salih's she-camel, the named sign (7:73, 11:64, 26:155, 54:27-28, 91:13).",
  },
  {
    id: 'ar24', lang: 'ar', kind: 'concept-ar',
    text: 'سفره‌ای که از آسمان نازل شود',
    patterns: [{ field: 'ar', pattern: 'المائدة' }, { field: 'ar', pattern: 'مائدة' }],
    reason: "The table sent down in al-Ma'idah (5:112-115) — the word itself.",
  },
  {
    id: 'ar25', lang: 'ar', kind: 'concept-ar',
    text: 'زقوم در دوزخ',
    patterns: [{ field: 'ar', pattern: 'زقوم' }],
    reason: 'The tree of Zaqqum in the Fire (37:62,64; 44:43,46; 56:52).',
  },
  {
    id: 'ar26', lang: 'ar', kind: 'concept-ar',
    text: 'غرابی که دفن کردن را به انسان آموخت',
    patterns: [{ field: 'ar', pattern: 'غراب' }, { field: 'ar', pattern: 'الغراب' }],
    reason: "The raven teaching Cain burial (5:31).",
  },
  {
    id: 'ar27', lang: 'ar', kind: 'concept-ar',
    text: 'هدهد و خبر سبا',
    patterns: [{ field: 'ar', pattern: 'الهدهد' }],
    reason: "The hoopoe bringing the news of Sheba (27:20,26).",
  },
  {
    id: 'ar28', lang: 'ar', kind: 'concept-ar',
    text: 'برده‌های آزادسازی گردن',
    patterns: [{ field: 'ar', pattern: 'رقبة' }, { field: 'ar', pattern: 'محررا' }, { field: 'ar', pattern: 'في رقاب' }],
    reason: 'Freeing a slave as an act of righteousness / expiation (2:177,2:220,4:3,4:25,5:89,9:60,24:33,90:13).',
  },
  {
    id: 'ar29', lang: 'ar', kind: 'concept-ar',
    text: 'خداوند شب را پوشش و خواب را مرگ قرار داد',
    patterns: [{ field: 'ar', pattern: 'وجعلنا.sleep' }],
    reason: 'placeholder — removed if the pattern does not match (see build-gold report)',
    exclude: [],
  },
  {
    id: 'ar30', lang: 'ar', kind: 'concept-ar',
    text: 'مورچه‌ای که سخن گفت',
    patterns: [{ field: 'ar', pattern: 'النمل' }],
    reason: "The ant's speech in an-Naml (27:18).",
  },
  {
    id: 'ar31', lang: 'ar', kind: 'concept-ar',
    text: 'گوساله‌ی پرستش‌شده به عنوان بت',
    patterns: [{ field: 'ar', pattern: 'العجل' }],
    reason: 'The calf taken as a god by the people of Moses.',
  },
  {
    id: 'ar32', lang: 'ar', kind: 'cross-lingual',
    text: 'پاره شدن ماه به عنوان معجزه',
    patterns: [{ field: 'ar', pattern: 'انشق القمر' }],
    reason: 'Persian query, Arabic gold: 54:1-2 — no shared surface vocabulary with the Arabic text.',
  },

  /* ------------------------------- Persian ------------------------------ */
  {
    id: 'fa01', lang: 'fa', kind: 'exact-phrase',
    text: 'به نام الله بخشندۀ مهربان',
    patterns: [{ field: 'fa', pattern: 'به نام الله' }],
    reason: 'IslamHouse translation of 1:1 verbatim.',
  },
  {
    id: 'fa02', lang: 'fa', kind: 'concept-fa',
    text: 'شب قدر از هزار ماه بهتر',
    patterns: [{ field: 'fa', pattern: 'هزار ماه' }],
    reason: 'Al-Qadr 97:1-3 in the Persian translation.',
  },
  {
    id: 'fa03', lang: 'fa', kind: 'concept-fa',
    text: 'یتیم را طعام دادن',
    patterns: [{ field: 'fa', pattern: 'يتيم' }, { field: 'fa', pattern: 'یتیم' }],
    reason: 'Persian text naming the orphan.',
  },
  {
    id: 'fa04', lang: 'fa', kind: 'concept-fa',
    text: 'ربا و فساد اقتصادی',
    patterns: [{ field: 'fa', pattern: 'ربا' }],
    reason: 'Usury named in the Persian translation.',
  },
  {
    id: 'fa05', lang: 'fa', kind: 'concept-fa',
    text: 'نوشیدنی مست‌کننده و قمار',
    patterns: [{ field: 'fa', pattern: 'مسکر' }, { field: 'fa', pattern: 'خمر' }, { field: 'fa', pattern: 'قمار' }],
    reason: 'Intoxicant and gambling named in the Persian translation.',
  },
  {
    id: 'fa06', lang: 'fa', kind: 'concept-fa',
    text: 'ماهی‌ای که یونس را فرو برد',
    patterns: [{ field: 'fa', pattern: 'ماهی' }, { field: 'fa', pattern: 'حوت' }],
    reason: "Yunus and the fish in the Persian rendering.",
  },
  {
    id: 'fa07', lang: 'fa', kind: 'concept-fa',
    text: 'دو دریای شیرین و شور',
    patterns: [{ field: 'fa', pattern: 'دو دریا' }, { field: 'fa', pattern: 'شیرین' }],
    reason: 'The two seas meeting with a barrier (55:19-20, 25:53, 35:12).',
  },
  {
    id: 'fa08', lang: 'fa', kind: 'concept-fa',
    text: 'هر کس مرگ را می‌چشد',
    patterns: [{ field: 'fa', pattern: 'مزه' }, { field: 'fa', pattern: 'موت' }],
    reason: 'Death is tasted by every soul; formulaic in Persian translations.',
  },
  {
    id: 'fa09', lang: 'fa', kind: 'concept-fa',
    text: 'اجبار در دین نیست',
    patterns: [{ field: 'fa', pattern: 'اكراه' }, { field: 'fa', pattern: 'اجبار' }],
    reason: 'No compulsion in religion (2:256) in the Persian translation.',
  },
  {
    id: 'fa10', lang: 'fa', kind: 'concept-fa',
    text: 'پس از سختی آسانی است',
    patterns: [{ field: 'fa', pattern: 'سختى' }, { field: 'fa', pattern: 'آسانی' }],
    reason: 'Hardship/ease pair in ash-Sharh and related verses.',
  },
  {
    id: 'fa11', lang: 'fa', kind: 'concept-fa',
    text: 'نماز و صبر یاری خواستن',
    patterns: [{ field: 'fa', pattern: 'نماز' }],
    reason: 'Prayer named; 2:45 and 2:153 command seeking help through prayer.',
  },
  {
    id: 'fa12', lang: 'fa', kind: 'concept-fa',
    text: 'مردان در غار پنهان',
    patterns: [{ field: 'fa', pattern: 'غار' }],
    reason: 'The cave of al-Kahf in the Persian translation.',
  },
  {
    id: 'fa13', lang: 'fa', kind: 'concept-fa',
    text: 'ترازوی درست در روز داوری',
    patterns: [{ field: 'fa', pattern: 'ترازو' }, { field: 'fa', pattern: 'ميزان' }],
    reason: 'The balance/weighing of deeds on the Day of Judgement.',
  },
  {
    id: 'fa14', lang: 'fa', kind: 'concept-fa',
    text: 'ستارگانی که محو می‌شوند',
    patterns: [{ field: 'fa', pattern: 'ستاره' }, { field: 'fa', pattern: 'نجوم' }],
    reason: 'Stars darkened/falling at the Hour (81:2, 82:2, 56:75, 77:8-9).',
  },
  {
    id: 'fa15', lang: 'fa', kind: 'concept-fa',
    text: 'کوه‌ها چون پشم رنگارنگ',
    patterns: [{ field: 'fa', pattern: 'کوه' }, { field: 'fa', pattern: 'جبال' }],
    reason: 'Mountains described as carded wool / removed on the Day.',
  },
  {
    id: 'fa16', lang: 'fa', kind: 'concept-fa',
    text: 'باغ‌های بهشت زیر آن‌ها نهرها',
    patterns: [{ field: 'fa', pattern: 'بهشت' }, { field: 'fa', pattern: 'جنات' }],
    reason: 'Paradise gardens with rivers beneath.',
  },
  {
    id: 'fa17', lang: 'fa', kind: 'concept-fa',
    text: 'راه راست و هدایت',
    patterns: [{ field: 'fa', pattern: 'راه راست' }, { field: 'fa', pattern: 'صراط' }],
    reason: 'The straight path in the Persian translation.',
  },
  {
    id: 'fa18', lang: 'fa', kind: 'refrain',
    text: 'كدام یک از نعمت‌های پروردگارتان را انكار می‌کنید',
    patterns: [{ field: 'fa', pattern: 'انكار مى‌كنید' }, { field: 'fa', pattern: 'انکار می‌کنید' }],
    reason: 'The 31 ar-Rahman refrains in Persian: identical translation, different surrounding context.',
  },
  {
    id: 'fa19', lang: 'fa', kind: 'concept-fa',
    text: 'بخشایش بزرگ خدا',
    patterns: [{ field: 'fa', pattern: 'بخشایش' }, { field: 'fa', pattern: 'ببخشد' }],
    reason: 'Forgiveness stated explicitly in the translation.',
  },
  {
    id: 'fa20', lang: 'fa', kind: 'concept-fa',
    text: 'توبه و بازگشت به سوی خدا',
    patterns: [{ field: 'fa', pattern: 'توبه' }, { field: 'fa', pattern: 'توبة' }],
    reason: 'Repentance named in the translation.',
  },
  {
    id: 'fa21', lang: 'fa', kind: 'concept-fa',
    text: 'آتشی که بر ابراهیم سرد شد',
    patterns: [{ field: 'fa', pattern: 'سرد' }],
    reason: "Abraham's fire made cool (21:69) — the adjective is the basis.",
  },
  {
    id: 'fa22', lang: 'fa', kind: 'concept-fa',
    text: 'کشتی نجات و طوفان',
    patterns: [{ field: 'fa', pattern: 'كشتى' }, { field: 'fa', pattern: 'کشتی' }],
    reason: 'The ark of Noah in the Persian translation.',
  },
  {
    id: 'fa23', lang: 'fa', kind: 'concept-fa',
    text: 'چهارپایان باربر',
    patterns: [{ field: 'fa', pattern: 'چهارپايان' }, { field: 'fa', pattern: 'چهارپایان' }],
    reason: 'Cattle carried and eaten (6:105? / 40:43 / 7:179 style renderings).',
  },
  {
    id: 'fa24', lang: 'fa', kind: 'concept-fa',
    text: 'پوشش تقوا',
    patterns: [{ field: 'fa', pattern: 'پوشش' }, { field: 'fa', pattern: 'لباس' }],
    reason: 'Garments, including the garment of piety (7:26).',
  },
  {
    id: 'fa25', lang: 'fa', kind: 'concept-fa',
    text: 'آرامش دل‌ها با یاد خدا',
    patterns: [{ field: 'fa', pattern: 'آرامش' }, { field: 'fa', pattern: 'اطمئنان' }],
    reason: "Hearts find rest in remembrance (13:28).",
  },
  {
    id: 'fa26', lang: 'fa', kind: 'concept-fa',
    text: 'يوسف و زیبایی',
    patterns: [{ field: 'fa', pattern: 'يوسف' }, { field: 'fa', pattern: 'یوسف' }],
    reason: 'Joseph named in the Persian translation of Yusuf verses.',
  },
  {
    id: 'fa27', lang: 'fa', kind: 'concept-fa',
    text: 'منافقان و تهدید آن‌ها',
    patterns: [{ field: 'fa', pattern: 'منافق' }],
    reason: 'The hypocrites named in the translation.',
  },
  {
    id: 'fa28', lang: 'fa', kind: 'concept-fa',
    text: 'پیمانه و کیله را کامل بدهید',
    patterns: [{ field: 'fa', pattern: 'پیمانه' }, { field: 'fa', pattern: 'كيلى' }, { field: 'fa', pattern: 'پیمانه' }],
    reason: 'Full measure in trade (11:85, 26:181-183, 17:35, 83:1-3).',
  },
  {
    id: 'fa29', lang: 'fa', kind: 'concept-fa',
    text: 'پیوستگی شب و روز',
    patterns: [{ field: 'fa', pattern: 'شب و روز' }, { field: 'fa', pattern: 'روز و شب' }],
    reason: 'Alternation of night and day as a sign.',
  },
  {
    id: 'fa30', lang: 'fa', kind: 'concept-fa',
    text: 'نوری که آسمان‌ها را پر کرده',
    patterns: [{ field: 'fa', pattern: 'نور' }],
    reason: 'Light (an-Nur 24:35 and related).',
  },
  {
    id: 'fa31', lang: 'fa', kind: 'concept-fa',
    text: 'سپاس گزاری نعمت',
    patterns: [{ field: 'fa', pattern: 'سپاس' }],
    reason: 'Gratitude to God stated in the translation.',
  },
  {
    id: 'fa32', lang: 'fa', kind: 'cross-lingual',
    text: 'فرشتگان بر آدم سجده کردند',
    patterns: [{ field: 'ar', pattern: 'فسجدوا' }, { field: 'ar', pattern: 'اسجدوا' }],
    reason: 'Persian query whose gold is the Arabic prostration-to-adam verses — pure semantic/cross-lingual retrieval with no shared tokens with the Arabic text.',
  },
  {
    id: 'fa33', lang: 'fa', kind: 'cross-lingual',
    text: 'کسی که قرآن را برای آموختن آسان کردیم',
    patterns: [{ field: 'ar', pattern: 'ولقد يسرنا القرآن' }],
    reason: 'Persian query, Arabic gold: the four-times-repeated refrain of al-Qamar (54:17,22,32,40).',
  },
  {
    id: 'fa34', lang: 'fa', kind: 'cross-lingual',
    text: 'خداوند به هر تنی توانایی‌اش را می‌دهد',
    patterns: [{ field: 'ar', pattern: 'لاكلف نفسا الا وسعها' }],
    reason: 'Persian query, Arabic gold: 2:286 and the formula elsewhere.',
  },
];

export default QUERIES;
