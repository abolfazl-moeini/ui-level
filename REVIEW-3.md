# ui-level —گزارش نهایی پایداری (REVIEW-3)

تاریخ بررسی: ۲۰۲۶-۱۱-۲۲، حدود ۱۷:۲۴–۱۷:۴۰ (GMT+3:30)
موضوع: بررسی مجدد پس از اعمال تمام اصلاحات `ISSUES.md` و `REVIEW-2.md` و پاسخ به این سؤال که آیا پروژه پایدار است.

---

## 1. پاسخ کوتاه

**بله — در محدودهای که تستها پوشش میدهند، پروژه پایدار است.** تمام موارد ثبتشده بسته شدهاند و خط لولهٔ verification کاملاً سبز است.

اما «پایدار» را با «آمادهٔ انتشار نهایی» نباید اشتباه گرفت: هنوز چند نکتهٔ غیرمسدودکننده وجود دارد (تغییرات commit نشدهاند، CI فقط Node 22 را میبیند، و تبدیل `AUTO` یک تقریب است). جزئیات در بخش ۴.

---

## 2. نتایج اجرای واقعی

| دستور | نتیجه |
| --- | --- |
| `npm run typecheck` | موفق، بدون خطا |
| `npm run build` | موفق (`tsup` target: `node20`) |
| `npm test` | **موفق: ۵ فایل / ۴۵ تست** (حدود ۲۳٫۸ ثانیه) |
| تستهای remediation | ۱۲ تست (از ۸ تست در دوره قبل) — تمام موفق |
| `node dist/cli.js --version` | `1.1.0` |

توزیع تستها: `figwright-converter` ۱۱، `figwright-bridge` ۱۰، `mutation` ۱۱، `dimension` ۱، `issues-remediation` ۱۲.

---

## 3. وضعیت موارد باقیمانده از گزارش قبلی

| مورد | وضعیت | شواهد |
| --- | --- | --- |
| NEW-001 (حالت فقط تصویر) | بسته شد | `src/index.ts:118` حالا `NormalizedSpecSchema.parse(refResult.spec)` را بهعنوان نقطهٔ واحد اعتبارسنجی اجرا میکند؛ `figma.adapter.ts:199` هم قبل از برگشت spec را validate میکند. تست NEW-001 اضافه شد. اجرای مجدد: `adapter: figma` + فقط `refImage` اکنون خطای صریح `Figma offline mode requires a reference specification JSON via --ref-spec or config.refSpec` میدهد، نه `pass`. |
| BUG-010 (واحد AUTO) | بسته شد | `AUTO` در `lineHeight` و `letterSpacing` پیادهسازی شد (fallback به `lineHeightPx`/`letterSpacingPx` و سپس `fontSize * 1.2` / `0`)؛ تست extension مربوطه سبز است. |
| BUG-011 (`baseDir` در MCP) | بسته شد | `McpImportSnapshotSchema.baseDir` با `refine` بررسی میکند که مسیر داخل `process.cwd()` بماند؛ تست مربوطه سبز است. |
| NEW-002 (شناسهٔ نود در هشدار paint) | بسته شد | `resolveSolidPaintColor(paint, currentNodeId)` شناسهٔ نود جاری را دریافت میکند؛ تست مربوطه سبز است. |
| NEW-003 (پاکسازی temp تست) | بسته شد | `afterAll` با `try/catch` دایرکتوری موقت `issues-remediation` را حذف میکند. |

همچنین IDEA-01 (یک نقطهٔ واحد اعتبارسنجی spec) عملاً پیادهسازی شده است.

---

## 4. موارد غیرمسدودکنندهٔ باقیمانده

1. **تغییرات هنوز commit نشدهاند.** `main` در `3bdd5d6` است و تمام فایلها (از جمله `ISSUES.md`، `REVIEW-2.md`، `REVIEW-3.md`، `LICENSE` و کد Figwright) در working tree هستند. تا commit نشود، هیچ CI یا releaseای این وضعیت را نخواهد دید.
2. **CI فقط Node 22 را تست میکند** در حالی که بسته برای Node 20 ساخته میشود. پیشنهاد IDEA-09 (matrix) هنوز اعمال نشده است.
3. **تبدیل `AUTO` یک تقریب است.** مقدار `fontSize * 1.2` برای line-height و `0` برای letter-spacing، رفتار preflight/CSS را تقریب میزند، نه یک مقدار دقیق Figwright. احتمال false-positive خفیف در فونتهایی با متریک غیرمعمول وجود دارد. این یک محدودیت طراحی است، نه خرابی تست.
4. **محدودیت `baseDir` در MCP وابسته به `process.cwd()` است.** اگر سرور MCP از خارج از ریشهٔ پروژه راهاندازی شود، برخی مسیرهای معتبر ممکن است رد شوند. رفتار امن است ولی نیازمند مستندسازی کوتاه است.
5. **تست MCP صرفاً schema را میسنجد، نه کل جریان stdio.** ایدهٔ IDEA-13 (تست smoke از طریق stdio) همچنان باز است.

---

## 5. نتیجهگیری و توصیهٔ بعدی

وضعیت فعلی را میتوان **«پایدار در سطح کد و تست»** توصیف کرد: ۴۵ تست سبز، تمام موارد false-positive شناختهشده بستهشده، و اعتبارسنجی spec در یک نقطهٔ مرکزی قرار گرفت.

برای تبدیل آن به **«پایدار در سطح release»**:

1. تغییرات را commit کنید (COMMIT message مناسب: `feat: add Figwright bridge, immutable snapshots and hardened spec validation`).
2. Matrix سادهٔ Node 20 + 22 به CI اضافه کنید.
3. یک تست smoke برای MCP stdio اضافه کنید.
4. محدودیت تقریب `AUTO` را در README مستند کنید.

> تمام نتایج بر اساس working tree زمان بررسی است.
