import 'package:flutter/material.dart';
import '../shared/widgets/bottom_nav.dart';
import '../features/quran/screens/home_screen.dart';
import '../features/quran/screens/quran_reader_screen.dart';
import '../features/hifz/screens/hifz_session_screen.dart';
import '../features/search/screens/search_screen.dart';

/// Main app shell with bottom navigation
/// Implements Material 3 navigation patterns with smooth transitions
class AppShell extends StatefulWidget {
  const AppShell({super.key});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _currentIndex = 0;

  final List<Widget> _screens = const [
    HomeScreen(),
    QuranReaderScreen(),
    HifzSessionScreen(),
    SearchScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _currentIndex,
        children: _screens,
      ),
      bottomNavigationBar: AppBottomNav(
        currentIndex: _currentIndex,
        onTap: (index) {
          setState(() {
            _currentIndex = index;
          });
        },
      ),
    );
  }
}
