# ui-level — گزارش بررسی مجدد کد (REVIEW-2)

تاریخ بررسی: ۲۰۲۶-۱۱-۲۲، حدود ۱۶:۲۹–۱۶:۴۵ (GMT+3:30)
موضوع: بازبینی اصلاحات انجامشده برای موارد ثبتشده در `ISSUES.md` (BUG-001 تا BUG-016) و شناسایی موارد باقیمانده.

> وضعیت مخزن در لحظه بررسی: تغییرات هنوز commit نشدهاند (`main` در `3bdd5d6`). فایلهای `ISSUES.md`، `REVIEW-2.md`، `LICENSE` و فایلهای جدید Figwright در working tree وجود دارند.

---

## 1. خلاصه اجرایی

| بررسی | نتیجه |
| --- | --- |
| `npm run typecheck` | موفق |
| `npm run build` | موفق (target اکنون `node20`) |
| `npm test` | **موفق: ۵ فایل / ۴۱ تست** (حدود ۲۲٫۵ ثانیه) |
| `node dist/cli.js --version` | `1.1.0` |
| خطای قبلی `SAFE_DELETE_BULK_CONFIRM_REQUIRED` | دیگر رخ نمیدهد |

از ۱۶ مورد قبلی:

- **۱۳ مورد کاملاً برطرف شدهاند.**
- **۳ مورد بهصورت جزئی برطرف شدهاند:** BUG-001، BUG-010، BUG-011.
- **یک مورد با اهمیت بالا باقی مانده** که عملاً ادامهٔ BUG-001 است: حالت «فقط تصویر مرجع» در adapter فیگما میتواند بدون هیچ specification نتیجهٔ `pass` بدهد (با اجرای واقعی تأیید شد).

---

## 2. وضعیت تکتک موارد قبلی

| ID | وضعیت | شواهد / توضیح |
| --- | --- | --- |
| BUG-001 | جزئی | `NormalizedSpecSchema` اکنون `min(1)` دارد، `isNormalizedSpec` آرایه خالی را رد میکند و `convertFigwrightToNormalizedSpec` با خطای `zero renderable nodes` متوقف میشود. با این حال حالت `adapter: figma` همراه با `--ref-image` بدون `--ref-spec` کماکان `nodes: []` برمیگرداند و `pass` میدهد — مورد NEW-001. |
| BUG-002 | برطرف | `figwright.converter.ts` اکنون از `absoluteBoundingBox` / `absoluteRenderBounds` برای width/height/x/y استفاده میکند (`nodeBbox`)؛ تست اختصاصی BUG-002 اضافه شده و سبز است. |
| BUG-003 | برطرف | `tests/figwright-bridge.test.ts` از `fs.mkdtempSync(os.tmpdir())` استفاده میکند و cleanup داخل `try/catch` محافظت شده است. پوشهٔ `.ui-level-bridge-test` دیگر در working tree نیست. |
| BUG-004 | برطرف | اسکریپت `pretest: npm run build` به `package.json` اضافه شد؛ `npm test` حتی از حالت تمیز هم کار میکند. |
| BUG-005 | برطرف | `importReferenceSnapshot` قبل از نوشتن، وجود snapshot قبلی را بررسی میکند و بدون `force` خطای `already exists ... Pass --force` میدهد. پرچم `--force` در CLI و MCP هم وجود دارد و README آن را مستند کرده است. |
| BUG-006 | برطرف | `isSnapshotDirectory` فقط `manifest.json` یا جفت دقیق `reference.json` + `reference.png` را میپذیرد. تست مربوطه با پوشهٔ `data.json` + `avatar.png` نتیجهٔ `false` میگیرد. |
| BUG-007 | برطرف | `loadReferenceSnapshot` هم در مسیر manifest و هم در fallback، spec را با `NormalizedSpecSchema.safeParse/parse` اعتبارسنجی میکند و خطای مشخص میدهد. |
| BUG-008 | برطرف | تابع `normalizeFigmaId()` اضافه شد: `card-1` دستنخورده میماند، `100-2` به `100:2` و `I100-2` به `100:2` تبدیل میشود. همان منطق در استخراج DOM و `normalizeRefKey` استفاده میشود. |
| BUG-009 | برطرف | وقتی نسبت تصویر به عرض root نزدیک ۱/۲/۳ نباشد، هشداری حاوی مقدار نسبت و توصیهٔ `--dpr` در manifest ثبت میشود؛ تست مربوطه سبز است. |
| BUG-010 | جزئی | هشدار برای paintهای غیر `SOLID` اضافه شد (مثلاً `GRADIENT_LINEAR`). با این حال واحد `AUTO` در `lineHeight` / `letterSpacing` هنوز نادیده گرفته میشود و هیچ کدی برای آن وجود ندارد. |
| BUG-011 | جزئی | `McpImportSnapshotSchema` با Zod اضافه شد و آرگومانها قبل از فراخوانی اعتبارسنجی میشوند. با این حال `baseDir` هنوز مسیر مطلق دلخواه را میپذیرد و به ریشهٔ پروژه محدود نشده است. |
| BUG-012 | برطرف (تقریباً) | نودهای بدون bounding box دیگر کل subtree را حذف نمیکنند؛ `figma-rest.normalizer` روی فرزندان recursion میکند. هشداری برای نود فاقد bbox وجود ندارد، اما از دست رفتن فرزندان برطرف شد. |
| BUG-013 | برطرف | README پرچمهای `--force`، `--skip-integrity`، `--dpr` و رفتار selectorMap/DPR/Integrity را مستند کرد. CLI گزینههای `--node-name`، `--revision`، `--plugin-version`، `--detail` گرفت؛ MCP نیز metadata مربوطه را اعتبارسنجی میکند. |
| BUG-014 | برطرف | `tsup.config.ts` از `node22` به `node20` تغییر یافت و با `engines: >=20` هماهنگ است. (تنها CI هنوز Node 22 را تست میکند — پیشنهاد IDEA-09 باقی است.) |
| BUG-015 | برطرف | فایل `LICENSE` (MIT, 2026 Abolfazl Moeini) اضافه و در `package.json.files` قرار گرفت. |
| BUG-016 | برطرف | تست دستکاری `reference.png` بایتهای اصلی را ذخیره و در بلوک `finally` بازمیگرداند؛ output directory هم موقت و منحصربهفرد است. |

---

## 3. موارد باقیمانده / تازه

### NEW-001 (بالا) — حالت «فقط تصویر» در adapter فیگما Gate 1 را تهی میکند

**شواهد:** با اجرای واقعی:

```js
check({
  targetUrl: 'tests/fixtures/base.html',
  adapter: 'figma',
  refImage: 'ref.png',       // بدون refSpec
  selector: '#test-card'
})
```

نتیجه:

```
{"status":"pass","style":0,"geometry":0,"pixel":true}
```

**علت:** `src/adapters/figma.adapter.ts` در حالت offline با `spec = { adapter: "figma", nodes: [] }` شروع میکند؛ اگر فقط `refImage` داده شود، هیچ مسیری این آرایه را پر نمیکند. `check()` هم spec نهایی adapter را با `NormalizedSpecSchema` اعتبارسنجی نمیکند (اعتبارسنجی فقط داخل snapshot manager است). بنابراین Gate 1 هیچ نودی برای مقایسه ندارد و در صورت تطابق پیکسل، نتیجه سبز میشود.

**پیشنهاد:** یا `--ref-spec` را در حالت offline اجباری کنید، یا قبل از Gate 1 در `src/index.ts` همیشه `NormalizedSpecSchema.parse(refResult.spec)` را اجرا کنید، یا حداقل هشدار صریح `No reference nodes; Gate 1 skipped` در `DeltaPacket.warnings` بگذارید و وضعیت را fail کنید.

### NEW-002 (کم) — هشدار paint نامعتبر، شناسهٔ اشتباهی را نشان میدهد

در `src/adapters/figwright.converter.ts:247-251` پیام هشدار همیشه از `rootNodeId` استفاده میکند، حتی وقتی paint متعلق به نود فرزند است. این موضوع عیبیابی را گیجکننده میکند؛ کافی است شناسهٔ نود جاری به `resolveSolidPaintColor` پاس داده شود.

### NEW-003 (کم) — تمیز نشدن دایرکتوری موقت تستهای اصلاحات

`tests/issues-remediation.test.ts` در سطح `describe` یک `mkdtempSync` ایجاد میکند ولی `afterAll` برای حذف آن ندارد. این دایرکتوریها در `/tmp` باقی میماند (داخل مخزن نیستند، ولی در CIهای طولانیمدت انباشته میشوند).

---

## 4. نتیجهگیری

کیفیت کد نسبت به دوره قبل بهطور محسوسی بهتر شده است: تستها کاملاً سبز شدهاند، قرارداد snapshotها محکمتر شده (force guard + validation + integrity) و نگاشت نودها از نظر رفتاری قابلپیشبینیتر است.

**ترتیب پیشنهادی اقدام بعدی:**

1. NEW-001 را برطرف کنید (تنها مورد باقیمانده با خطر false-positive).
2. BUG-010 (واحد AUTO) و BUG-011 (محدود کردن `baseDir` در MCP) را تکمیل کنید.
3. سپس سراغ IDEAها در `ISSUES.md` بروید — بهخصصوص IDEA-01 (یک نقطهٔ واحد اعتبارسنجی) که NEW-001 را هم بهطور ساختاری حل میکند.

> تمام نتایج فوق بر اساس working tree زمان بررسی است؛ اقدام به commit نشده است.
