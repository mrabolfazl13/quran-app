# راهنمای ساخت APK اندروید - مشکل شبکه و راه‌حل‌ها

**تاریخ:** 2026-09-30
**وضعیت:** ⚠️ مسدود شده - عدم دسترسی به مخازن Maven

---

## مشکل اصلی

سیستم نمی‌تواند Android Gradle Plugin (AGP) را از مخازن آنلاین دانلود کند:
```
Plugin [id: 'com.android.application'] was not found
Searched in: Google, MavenCentral, Gradle Plugin Portal
```

**علت:** محدودیت شبکه/فایروال در دسترسی به:
- https://dl.google.com/dl/android/maven2/
- https://repo.maven.apache.org/maven2/

---

## ✅ راه‌حل‌های امتحان شده (ناموفق)

1. ❌ تغییر نسخه AGP (8.7.0 → 8.2.2 → 8.1.0 → 7.4.2 → 8.3.2)
2. ❌ افزودن میرورهای ایرانی (maven.irandev.org)
3. ❌ بازسازی پروژه Flutter
4. ❌ بررسی اتصال اینترنت (ping موفق بود)

**نتیجه:** مشکل از فرمت نیست، بلکه دسترسی مستقیم به Maven مسدود است.

---

## 🎯 راه‌حل‌های پیشنهادی

### راه‌حل ۱: استفاده از کش Gradle موجود (سریع‌ترین)

اگر قبلاً روی این ماشین پروژه Flutter/Android ساخته‌اید:

```bash
# بررسی وجود کش
dir C:\Users\Alex\.gradle\caches\modules-2\files-2.1\com.android.tools.build

# اگر وجود دارد، پاکسازی و ساخت مجدد
cd I:/Codes/Quran/mobile
flutter clean
flutter build apk --release
```

### راه‌حل ۲: انتقال کش از ماشین دیگر

**از ماشینی که Android Studio دارد:**
```bash
# کپی پوشه کش Gradle
xcopy C:\Users\[Username]\.gradle\caches X:\gradle-cache /E /I
```

**به این ماشین:**
```bash
# پیست در همان مسیر
xcopy X:\gradle-cache C:\Users\Alex\.gradle\caches /E /I
```

**سپس ساخت:**
```bash
cd I:/Codes/Quran/mobile
flutter build apk --release
```

### راه‌حل ۳: استفاده از Android Studio GUI

Android Studio ممکن است پلاگین‌ها را از قبل داشته باشد:

1. Android Studio را باز کنید
2. `File > Open` → پوشه `I:\Codes\Quran\mobile\android`
3. صبر کنید تا Gradle sync کامل شود
4. `Build > Build Bundle(s) / APK(s) > Build APK(s)`

### راه‌حل ۴: ساخت روی ماشین دیگر/سرور ابری

**انتقال پروژه:**
```bash
# در همین ماشین
cd I:/Codes/Quran
tar -czf quran-mobile.tar.gz mobile/ \
  --exclude='mobile/build' \
  --exclude='mobile/.dart_tool' \
  --exclude='mobile/android/.gradle'
```

**در ماشین مقصد با اینترنت:**
```bash
tar -xzf quran-mobile.tar.gz
cd mobile
flutter pub get
flutter build apk --release
```

**APK تولید شده:**
```
mobile/build/app/outputs/flutter-apk/app-release.apk
```

### راه‌حل ۵: تنظیم پروکسی سازمانی

اگر از پروکسی استفاده می‌کنید:

**ویرایش `mobile/android/gradle.properties`:**
```properties
systemProp.http.proxyHost=proxy.yourcompany.com
systemProp.http.proxyPort=8080
systemProp.https.proxyHost=proxy.yourcompany.com
systemProp.https.proxyPort=8080
systemProp.http.nonProxyHosts=localhost|127.0.0.1
```

**سپس:**
```bash
flutter clean
flutter build apk --release
```

---

## 🔍 تشخیص دقیق‌تر

برای بررسی اینکه کدام مخزن قابل دسترسی است:

```bash
# تست Google Maven
curl -I "https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/8.3.2/gradle-8.3.2.pom"

# تست Maven Central
curl -I "https://repo.maven.apache.org/maven2/com/android/tools/build/gradle/8.3.2/gradle-8.3.2.pom"

# تست Gradle Portal
curl -I "https://plugins.gradle.org/m2/com/android/tools/build/gradle/8.3.2/gradle-8.3.2.pom"
```

اگر همه 404 برگردانند، مشکل از DNS یا فایروال است.

---

## 📦 حجم APK نهایی

پس از ساخت موفق، انتظار می‌رود:

| نوع | حجم تقریبی | توضیح |
|-----|------------|--------|
| Debug APK | ~80-100 MB | شامل نمادهای دیباگ |
| Release APK | ~40-60 MB | بهینه‌شده، بدون دیباگ |
| App Bundle (.aab) | ~30-45 MB | برای Play Store |

**بهینه‌سازی حجم:**
```bash
# Split per ABI (armeabi-v7a, arm64-v8a, x86_64)
flutter build apk --release --split-per-abi
```

---

## ✅ وضعیت فعلی پروژه

### کد کاملاً آماده است:
- ✅ تمام ۴ صفحه پیاده‌سازی شده
- ✅ سیستم ناوبری Material 3
- ✅ تایپوگرافی RTL فارسی/عربی
- ✅ انیمیشن‌های روان و مدرن
- ✅ بیلد وب موفق (اثبات کامپایل)

### فایل‌های Android:
- ✅ `android/settings.gradle.kts` پیکربندی شده
- ✅ `android/build.gradle.kts` پیکربندی شده
- ✅ `android/app/build.gradle.kts` آماده امضا
- ⚠️ فقط نیاز به دانلود AGP دارد

---

## 🚀 سریع‌ترین مسیر به APK

**گزینه A:** اگر Android Studio نصب دارید:
1. Android Studio را باز کنید
2. پروژه `mobile/android` را باز کنید
3. بگذارید Gradle sync انجام شود (ممکن است چند دقیقه طول بکشد)
4. `Build > Build APK` را بزنید

**گزینه B:** اگر ماشین دیگری با اینترنت دارید:
1. پروژه را zip کنید (بدون پوشه build)
2. به ماشین دیگر منتقل کنید
3. `flutter build apk --release` اجرا کنید
4. APK را برگردانید

**گزینه C:** اگر همکارانی با پروژه مشابه دارید:
1. پوشه `.gradle/caches` آن‌ها را بگیرید
2. در ماشین خود کپی کنید
3. دوباره بسازید

---

## 📞 پشتیبانی

اگر هیچ‌کدام کار نکرد، اطلاعات زیر را ارائه دهید:
1. خروجی `flutter doctor -v`
2. آیا Android Studio نصب دارید؟
3. آیا از VPN/proxy استفاده می‌کنید؟
4. خروجی `tracert dl.google.com`

---

## نتیجه‌گیری

**مشکل:** محدودیت شبکه در دسترسی به مخازن Maven
**راه‌حل:** استفاده از کش محلی، Android Studio، یا ماشین دیگر
**زمان مورد نیاز:** ۵-۱۵ دقیقه پس از رفع مشکل شبکه

کد فلاتر ۱۰۰٪ آماده است و فقط نیاز به تکمیل فرآیند بیلد Gradle دارد.
