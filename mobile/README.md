# Quran Platform - Flutter Android App

Modern Islamic learning application built with Flutter, featuring glassmorphism design, smooth animations and a mobile-first responsive layout.

## Features

- **Modern UI/UX**: Glassmorphism effects, smooth spring-based animations, gradient accents
- **Offline First**: All content stored locally in SQLite, no network required
- **RTL Support**: Full Persian/Arabic text rendering with proper typography
- **Dark Mode**: System-aware theme switching with luminous dark palette
- **Accessibility**: WCAG AA+ contrast ratios, large touch targets, screen reader support

## Architecture

```
lib/
├── core/                    # Shared business logic
│   ├── models/             # Data models
│   ├── services/           # Core services (gateway, storage)
│   └── contracts/          # Type definitions
├── features/               # Feature modules
│   ├── quran/             # Quran reading, navigation
│   │   ├── screens/
│   │   ├── widgets/
│   │   └── data/
│   ├── hifz/              # Memorization sessions
│   │   ├── screens/
│   │   ├── widgets/
│   │   └── engine/
│   ├── search/            # Search & concepts
│   └── me/                # User settings, backup
└── shared/                # Shared UI components
    ├── widgets/           # Reusable components
    ├── theme/             # Design tokens, themes
    └── data/              # Gateway implementations
```

## Getting Started

### Prerequisites

- Flutter SDK 3.13.2 or higher
- Android Studio / VS Code with Flutter extensions
- Android device or emulator (API 21+)

### Installation

```bash
cd mobile
flutter pub get
flutter run
```

### Building APK

```bash
flutter build apk --release
```

The APK will be generated at `build/app/outputs/flutter-apk/app-release.apk`

## Design System

This app follows the same design system as the desktop/web versions:

### Colors

- **Primary**: Sacred emerald green (`#1C6A55`)
- **Secondary**: Luminous gold (`#B8860B`)
- **Background**: Warm paper (light) / Deep cosmic space (dark)

### Typography

- **UI Text**: Vazirmatn (Persian/Arabic optimized)
- **Quran Text**: Amiri (classical Arabic calligraphy)
- **Scale**: Fluid sizing from 12px to 36px

### Components

- **ModernCard**: Glassmorphism effect with backdrop blur
- **AnimatedList**: Staggered entrance animations
- **SkeletonLoader**: Shimmer loading placeholders
- **GradientText**: Animated gradient for emphasis

## State Management

Uses Provider for simple, reactive state management:

```dart
ChangeNotifierProvider(
  create: (_) => HifzEngine(),
  child: Consumer<HifzEngine>(
    builder: (context, engine, _) => ...,
  ),
)
```

## Local Storage

SQLite database matching the desktop schema:

```dart
// Example: Load home stats
final db = await openDatabase('quran.db');
final stats = await db.rawQuery('SELECT COUNT(*) FROM ayahs');
```

## Testing

```bash
# Run all tests
flutter test

# Run with coverage
flutter test --coverage
```

## Performance Tips

1. **Use const constructors** where possible
2. **Avoid rebuilding** entire widget trees - use selective rebuilds
3. **Cache images** and expensive computations
4. **Use ListView.builder** for long lists (50+ items)
5. **Debounce search** inputs (300ms delay)

## Contributing

1. Follow the established folder structure
2. Use semantic color tokens, never hardcode hex values
3. Add both light and dark mode variants for new UI
4. Write widget tests for all new components
5. Update this README when adding major features

## License

Same license as the main Quran Platform repository.

## Roadmap

- [ ] Quran reader with page-by-page navigation
- [ ] Hifz session runner with recall modes
- [ ] Search with FTS5 full-text search
- [ ] Backup/restore functionality
- [ ] Audio playback support
- [ ] Tafsir integration
- [ ] Mutashabihat similar verses

---

Built with ❤️ for the Quran community
