import 'package:flutter/material.dart';
import '../../../shared/widgets/modern_card.dart';
import '../../../shared/theme/app_colors.dart';

/// Modern home screen showcasing the new design system
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  bool _loading = true;
  
  // Mock stats - will be replaced with real data
  final Map<String, dynamic> _stats = {
    'hifzActive': 12,
    'hifzDueToday': 5,
    'hifzWeak': 3,
    'confusionGroups': 2,
    'recallAttempts': 48,
    'hasContent': true,
  };

  @override
  void initState() {
    super.initState();
    // Simulate loading
    Future.delayed(const Duration(milliseconds: 500), () {
      if (mounted) setState(() => _loading = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Header
              _buildHeader(),
              const SizedBox(height: 24),
              
              // Stats Grid
              if (_loading) _buildLoadingGrid() else _buildStatsGrid(),
              const SizedBox(height: 24),
              
              // Quick Actions
              if (_loading) const SizedBox.shrink() else _buildQuickActions(),
              if (!_loading) const SizedBox(height: 24),
              
              // Progress Overview
              if (!_loading) _buildProgressOverview(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ShaderMask(
          shaderCallback: (bounds) {
            return const LinearGradient(
              colors: [AppColors.accent, AppColors.gold],
            ).createShader(bounds);
          },
          child: const Text(
            'پلتفرم قرآن',
            style: TextStyle(
              fontSize: 32,
              fontWeight: FontWeight.bold,
              color: Colors.white,
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          'یادگیری، فهم و حفظ قرآن کریم',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      ],
    );
  }

  Widget _buildLoadingGrid() {
    return GridView.count(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      crossAxisCount: 2,
      mainAxisSpacing: 16,
      crossAxisSpacing: 16,
      childAspectRatio: 1.2,
      children: List.generate(4, (index) {
        return const ModernCard(
          child: Padding(
            padding: EdgeInsets.all(16),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                SkeletonLoader(width: 48, height: 48, borderRadius: 24),
                SizedBox(height: 12),
                SkeletonLoader(width: 60, height: 24),
                SizedBox(height: 8),
                SkeletonLoader(width: 80, height: 16),
              ],
            ),
          ),
        );
      }),
    );
  }

  Widget _buildStatsGrid() {
    return GridView.count(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      crossAxisCount: 2,
      mainAxisSpacing: 16,
      crossAxisSpacing: 16,
      childAspectRatio: 1.2,
      children: [
        _StatCard(
          icon: Icons.book,
          value: '${_stats['hifzActive']}',
          label: 'آیات فعال',
          subtitle: '${_stats['hifzDueToday']} مرور امروز',
          color: AppColors.accent,
        ),
        _StatCard(
          icon: Icons.trending_up,
          value: '${_stats['hifzWeak']}',
          label: 'نیاز به تمرین',
          subtitle: '${_stats['confusionGroups']} گروه متشابه',
          color: AppColors.gold,
        ),
      ],
    );
  }

  Widget _buildQuickActions() {
    return ModernCard(
      elevated: true,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'دسترسی سریع',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: () {}, // TODO: Navigate to Quran
              icon: const Icon(Icons.menu_book),
              label: const Text('مطالعه قرآن'),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () {}, // TODO: Navigate to Hifz
              icon: const Icon(Icons.auto_stories),
              label: const Text('جلسه حفظ'),
            ),
            const SizedBox(height: 12),
            TextButton.icon(
              onPressed: () {}, // TODO: Navigate to Search
              icon: const Icon(Icons.search),
              label: const Text('جستجو و کاوش'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildProgressOverview() {
    return ModernCard(
      child: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: [
              AppColors.accent.withOpacity(0.9),
              AppColors.gold.withOpacity(0.8),
            ],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
          borderRadius: BorderRadius.circular(18),
        ),
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.analytics, color: Colors.white),
                SizedBox(width: 8),
                Text(
                  'پیشرفت کلی',
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            _ProgressItem(
              label: 'تلاش‌های یادآوری',
              value: '${_stats['recallAttempts']}',
            ),
            const SizedBox(height: 12),
            _ProgressItem(
              label: 'محتوا',
              value: _stats['hasContent'] ? '✓' : '✗',
            ),
          ],
        ),
      ),
    );
  }
}

class _StatCard extends StatelessWidget {
  final IconData icon;
  final String value;
  final String label;
  final String subtitle;
  final Color color;

  const _StatCard({
    required this.icon,
    required this.value,
    required this.label,
    required this.subtitle,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return ModernCard(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: color.withOpacity(0.12),
              ),
              child: Icon(icon, color: color, size: 28),
            ),
            const SizedBox(height: 12),
            Text(
              value,
              style: const TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              label,
              style: Theme.of(context).textTheme.bodySmall,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 4),
            Text(
              subtitle,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                fontSize: 11,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

class _ProgressItem extends StatelessWidget {
  final String label;
  final String value;

  const _ProgressItem({
    required this.label,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.1),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: const TextStyle(color: Colors.white),
          ),
          Text(
            value,
            style: const TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
