/**
 * Public service catalogue (display content only).
 * Content is general & informational — no prices, no durations, no outcome promises.
 * The booking engine uses the backend `services` table (duration, active flag) as the
 * source of truth; slugs here MUST match backend/schema.sql seed slugs.
 */
window.CLINIC_SERVICES = [
  {
    slug: "teeth-whitening", category: "cosmetic", icon: "fa-wand-magic-sparkles",
    name_en: "Teeth Whitening", name_ar: "تبييض الأسنان",
    short_en: "A cosmetic procedure aimed at lightening the shade of natural teeth.",
    short_ar: "إجراء تجميلي يهدف إلى تفتيح لون الأسنان الطبيعية.",
    long_en: "Teeth whitening is a cosmetic dental procedure used to lighten the colour of natural teeth. The dentist first examines your teeth and gums to determine whether whitening is suitable and which approach fits your situation.",
    long_ar: "تبييض الأسنان إجراء تجميلي يُستخدم لتفتيح لون الأسنان الطبيعية. يقوم الطبيب أولاً بفحص الأسنان واللثة لتحديد مدى ملاءمة التبييض والطريقة المناسبة لحالتك.",
    points_en: ["Initial examination of teeth and gums", "Discussion of your expectations", "Aftercare guidance from the dentist"],
    points_ar: ["فحص أولي للأسنان واللثة", "مناقشة توقعاتك مع الطبيب", "إرشادات العناية بعد الإجراء"]
  },
  {
    slug: "emax", category: "cosmetic", icon: "fa-gem",
    name_en: "EMAX", name_ar: "إيماكس EMAX",
    short_en: "Restorations made from E.max lithium-disilicate ceramic.",
    short_ar: "تركيبات مصنوعة من سيراميك إيماكس (ليثيوم ديسيليكات).",
    long_en: "EMAX (IPS e.max) is an all-ceramic material used in cosmetic and restorative dentistry, for example in veneers and crowns. Whether EMAX is appropriate for you is decided by the dentist after a clinical assessment.",
    long_ar: "إيماكس (IPS e.max) مادة سيراميكية بالكامل تُستخدم في تجميل وترميم الأسنان، مثل القشور والتيجان. يحدد الطبيب مدى ملاءمة الإيماكس لحالتك بعد التقييم السريري.",
    points_en: ["All-ceramic material", "Used for veneers and crowns", "Planned after clinical assessment"],
    points_ar: ["مادة سيراميكية بالكامل", "تُستخدم للقشور والتيجان", "يُخطط لها بعد التقييم السريري"]
  },
  {
    slug: "cosmetic-dentistry", category: "cosmetic", icon: "fa-face-smile",
    name_en: "Cosmetic Dentistry & Facial Aesthetics", name_ar: "تجميل الأسنان والتجميل الوجهي",
    short_en: "Treatments focused on the appearance of the smile and face.",
    short_ar: "علاجات تركز على مظهر الابتسامة والوجه.",
    long_en: "Cosmetic dentistry covers treatments that focus on the appearance of teeth and the smile. Facial aesthetic options are discussed during consultation. Your dentist will explain which options may be suitable after examining you.",
    long_ar: "يشمل تجميل الأسنان العلاجات التي تركز على مظهر الأسنان والابتسامة، وتتم مناقشة خيارات التجميل الوجهي أثناء الاستشارة. سيوضح لك الطبيب الخيارات التي قد تناسبك بعد الفحص.",
    points_en: ["Smile-focused consultation", "Options explained by the dentist", "Personal treatment planning"],
    points_ar: ["استشارة تركز على الابتسامة", "شرح الخيارات من قبل الطبيب", "خطة علاج خاصة بك"]
  },
  {
    slug: "orthodontic-treatment", category: "orthodontics", icon: "fa-teeth",
    name_en: "Orthodontic Treatment", name_ar: "تقويم الأسنان",
    short_en: "Treatment to align teeth and correct bite irregularities.",
    short_ar: "علاج لتنظيم صف الأسنان وتصحيح مشاكل الإطباق.",
    long_en: "Orthodontic treatment aims to align teeth and address bite irregularities using braces or aligners. The type of appliance and the treatment plan are determined after an orthodontic assessment.",
    long_ar: "يهدف تقويم الأسنان إلى تنظيم صف الأسنان ومعالجة مشاكل الإطباق باستخدام التقويم الثابت أو المتحرك. يُحدد نوع الجهاز وخطة العلاج بعد التقييم التقويمي.",
    points_en: ["Orthodontic assessment", "Choice of appliance discussed", "Regular follow-up visits"],
    points_ar: ["تقييم تقويمي", "مناقشة نوع جهاز التقويم", "زيارات متابعة دورية"]
  },
  {
    slug: "gold-braces", category: "orthodontics", icon: "fa-star",
    name_en: "Gold Braces", name_ar: "التقويم الذهبي",
    short_en: "Fixed braces with gold-coloured brackets.",
    short_ar: "تقويم ثابت بحاصرات ذهبية اللون.",
    long_en: "Gold braces are fixed orthodontic braces with gold-coloured brackets, chosen by some patients for their distinctive look. Suitability is confirmed during the orthodontic assessment.",
    long_ar: "التقويم الذهبي تقويم ثابت بحاصرات ذهبية اللون يختاره بعض المراجعين لمظهره المميز. يتم تأكيد مدى الملاءمة أثناء التقييم التقويمي.",
    points_en: ["Fixed orthodontic appliance", "Gold-coloured brackets", "Planned after assessment"],
    points_ar: ["جهاز تقويم ثابت", "حاصرات بلون ذهبي", "يُخطط له بعد التقييم"]
  },
  {
    slug: "metal-braces", category: "orthodontics", icon: "fa-grip-lines",
    name_en: "Metal Braces", name_ar: "التقويم المعدني",
    short_en: "Conventional fixed braces with metal brackets.",
    short_ar: "تقويم ثابت تقليدي بحاصرات معدنية.",
    long_en: "Metal braces are conventional fixed orthodontic appliances made of stainless-steel brackets and wires. Your orthodontic plan is explained after examination.",
    long_ar: "التقويم المعدني جهاز تقويم ثابت تقليدي يتكون من حاصرات وأسلاك من الفولاذ المقاوم للصدأ. يتم شرح خطة التقويم بعد الفحص.",
    points_en: ["Stainless-steel brackets", "Fixed appliance", "Regular adjustment visits"],
    points_ar: ["حاصرات من الفولاذ", "جهاز ثابت", "زيارات تعديل دورية"]
  },
  {
    slug: "clear-braces", category: "orthodontics", icon: "fa-circle-half-stroke",
    name_en: "Clear Braces", name_ar: "التقويم الشفاف",
    short_en: "Fixed braces with clear or tooth-coloured brackets.",
    short_ar: "تقويم ثابت بحاصرات شفافة أو بلون الأسنان.",
    long_en: "Clear braces work like conventional fixed braces but use clear or tooth-coloured brackets that are less noticeable. The dentist will advise whether they suit your case.",
    long_ar: "يعمل التقويم الشفاف مثل التقويم الثابت التقليدي لكن بحاصرات شفافة أو بلون الأسنان تكون أقل وضوحاً. سيوضح لك الطبيب مدى ملاءمته لحالتك.",
    points_en: ["Less noticeable brackets", "Fixed appliance", "Planned after assessment"],
    points_ar: ["حاصرات أقل وضوحاً", "جهاز ثابت", "يُخطط له بعد التقييم"]
  },
  {
    slug: "clear-aligners", category: "orthodontics", icon: "fa-teeth-open",
    name_en: "Removable Clear Aligners", name_ar: "التقويم الشفاف المتحرك",
    short_en: "Removable transparent trays used for orthodontic alignment.",
    short_ar: "قوالب شفافة متحركة تُستخدم لتقويم الأسنان.",
    long_en: "Clear aligners are a series of removable transparent trays used in orthodontic treatment. They are not suitable for every case; the dentist determines suitability after assessment.",
    long_ar: "التقويم الشفاف المتحرك سلسلة من القوالب الشفافة القابلة للإزالة تُستخدم في علاج التقويم. لا يناسب جميع الحالات، ويحدد الطبيب مدى الملاءمة بعد التقييم.",
    points_en: ["Removable transparent trays", "Suitability decided by the dentist", "Follow-up visits"],
    points_ar: ["قوالب شفافة قابلة للإزالة", "يحدد الطبيب مدى الملاءمة", "زيارات متابعة"]
  },
  {
    slug: "dental-fillings", category: "general", icon: "fa-tooth",
    name_en: "Dental Fillings", name_ar: "حشوات الأسنان",
    short_en: "Restoring teeth affected by decay or minor damage.",
    short_ar: "ترميم الأسنان المتأثرة بالتسوس أو الضرر البسيط.",
    long_en: "Dental fillings restore teeth affected by decay or minor damage. After examining the tooth, the dentist explains the recommended filling material and procedure.",
    long_ar: "تُستخدم حشوات الأسنان لترميم الأسنان المتأثرة بالتسوس أو الضرر البسيط. بعد فحص السن، يشرح الطبيب نوع مادة الحشوة والإجراء المناسب.",
    points_en: ["Examination of the affected tooth", "Filling material explained", "Aftercare guidance"],
    points_ar: ["فحص السن المتأثر", "شرح مادة الحشوة", "إرشادات العناية بعد الإجراء"]
  },
  {
    slug: "wisdom-tooth-extraction", category: "general", icon: "fa-user-doctor",
    name_en: "Wisdom Tooth Extraction", name_ar: "قلع ضرس العقل",
    short_en: "Surgical or simple removal of wisdom teeth when indicated.",
    short_ar: "إزالة ضرس العقل جراحياً أو بشكل بسيط عند الحاجة.",
    long_en: "Wisdom tooth extraction is the removal of one or more third molars when clinically indicated. The dentist examines the tooth — and may request imaging — before deciding on the approach.",
    long_ar: "قلع ضرس العقل هو إزالة ضرس أو أكثر من الأضراس الثالثة عند وجود حاجة سريرية. يفحص الطبيب السن — وقد يطلب صورة أشعة — قبل تحديد الطريقة المناسبة.",
    points_en: ["Clinical examination", "Imaging if required", "Post-extraction instructions"],
    points_ar: ["فحص سريري", "صورة أشعة عند الحاجة", "تعليمات ما بعد القلع"]
  }
];

window.CLINIC_CATEGORIES = [
  { id: "cosmetic", name_en: "Cosmetic Dentistry", name_ar: "تجميل الأسنان" },
  { id: "orthodontics", name_en: "Orthodontics", name_ar: "تقويم الأسنان" },
  { id: "general", name_en: "General & Surgical Dentistry", name_ar: "طب الأسنان العام والجراحي" }
];
