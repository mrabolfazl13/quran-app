import 'dart:async';
import 'package:flutter/material.dart';
import '../../../shared/widgets/modern_card.dart';
import '../../../shared/theme/app_colors.dart';

/// Premium search experience with filters and recent queries
/// - Debounced input for performance
/// - Filter chips for categories
/// - Highlighted matches in results
/// - Empty state illustration
class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  String _query = '';
  bool _isLoading = false;
  String? _activeFilter;

  // Mock recent searches
  final List<String> _recentSearches = [
    'رحمت خدا',
    'قیامت',
    'نماز',
  ];

  // Mock results
  final List<Map<String, String>> _results = [];

  Timer? _debounceTimer;

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    _debounceTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: TextField(
          controller: _controller,
          focusNode: _focusNode,
          decoration: InputDecoration(
            hintText: 'جستجو در آیات، ترجمه‌ها...',
            border: InputBorder.none,
            suffixIcon: _query.isNotEmpty
                ? IconButton(
                    icon: const Icon(Icons.clear),
                    onPressed: () {
                      _controller.clear();
                      setState(() => _query = '');
                    },
                  )
                : null,
          ),
          onChanged: (value) {
            setState(() => _query = value);
            _debounceSearch(value);
          },
        ),
      ),
      body: Column(
        children: [
          // Filter chips
          if (_query.isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    _FilterChip(
                      label: 'همه',
                      isSelected: _activeFilter == null,
                      onTap: () => setState(() => _activeFilter = null),
                    ),
                    const SizedBox(width: 8),
                    _FilterChip(
                      label: 'آیات',
                      isSelected: _activeFilter == 'verses',
                      onTap: () => setState(() => _activeFilter = 'verses'),
                    ),
                    const SizedBox(width: 8),
                    _FilterChip(
                      label: 'ترجمه',
                      isSelected: _activeFilter == 'translation',
                      onTap: () => setState(() => _activeFilter = 'translation'),
                    ),
                    const SizedBox(width: 8),
                    _FilterChip(
                      label: 'تفسیر',
                      isSelected: _activeFilter == 'tafsir',
                      onTap: () => setState(() => _activeFilter = 'tafsir'),
                    ),
                  ],
                ),
              ),
            ),

          // Content area
          Expanded(
            child: _query.isEmpty
                ? _buildRecentSearches()
                : _isLoading
                    ? _buildLoadingState()
                    : _results.isEmpty
                        ? _buildEmptyState()
                        : _buildResults(),
          ),
        ],
      ),
    );
  }

  Widget _buildRecentSearches() {
    if (_recentSearches.isEmpty) {
      return Center(
        child: Text(
          'جستجوی خود را شروع کنید',
          style: TextStyle(color: Colors.grey[600]),
        ),
      );
    }

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          'جستجوهای اخیر',
          style: Theme.of(context).textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 12),
        ..._recentSearches.map((search) => ModernCard(
              child: ListTile(
                leading: const Icon(Icons.history),
                title: Text(search),
                trailing: IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () {
                    setState(() => _recentSearches.remove(search));
                  },
                ),
                onTap: () {
                  _controller.text = search;
                  setState(() => _query = search);
                },
              ),
            )),
      ],
    );
  }

  Widget _buildLoadingState() {
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: 5,
      separatorBuilder: (_, __) => const SizedBox(height: 12),
      itemBuilder: (context, index) => Container(
        height: 80,
        decoration: BoxDecoration(
          color: Colors.grey[200],
          borderRadius: BorderRadius.circular(12),
        ),
        child: const Center(
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.search_off,
              size: 80,
              color: Colors.grey[400],
            ),
            const SizedBox(height: 24),
            Text(
              'نتیجه‌ای یافت نشد',
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              'عبارت دیگری را امتحان کنید',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.grey[600]),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildResults() {
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: _results.length,
      separatorBuilder: (_, __) => const SizedBox(height: 12),
      itemBuilder: (context, index) {
        final result = _results[index];
        return ModernCard(
          child: ListTile(
            title: Text(result['text'] ?? ''),
            subtitle: Text(result['reference'] ?? ''),
            trailing: const Icon(Icons.chevron_right),
            onTap: () {
              // Navigate to verse
            },
          ),
        );
      },
    );
  }

  void _debounceSearch(String value) {
    _debounceTimer?.cancel();
    _debounceTimer = Timer(const Duration(milliseconds: 300), () {
      if (value.trim().isNotEmpty) {
        setState(() => _isLoading = true);
        // Simulate API call
        Future.delayed(const Duration(milliseconds: 500), () {
          if (mounted) {
            setState(() {
              _isLoading = false;
              // TODO: Replace with real search via gateway
              _results.clear();
            });
          }
        });
      }
    });
  }
}

/// Filter chip with selection state
class _FilterChip extends StatefulWidget {
  final String label;
  final bool isSelected;
  final VoidCallback onTap;

  const _FilterChip({
    required this.label,
    required this.isSelected,
    required this.onTap,
  });

  @override
  State<_FilterChip> createState() => _FilterChipState();
}

class _FilterChipState extends State<_FilterChip> {
  bool _isPressed = false;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTapDown: (_) => setState(() => _isPressed = true),
      onTapUp: (_) {
        setState(() => _isPressed = false);
        widget.onTap();
      },
      onTapCancel: () => setState(() => _isPressed = false),
      child: AnimatedScale(
        scale: _isPressed ? 0.95 : 1.0,
        duration: const Duration(milliseconds: 100),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: BoxDecoration(
            color: widget.isSelected
                ? AppColors.accent.withOpacity(0.15)
                : Colors.grey[100],
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: widget.isSelected ? AppColors.accent : Colors.transparent,
              width: 2,
            ),
          ),
          child: Text(
            widget.label,
            style: TextStyle(
              color: widget.isSelected ? AppColors.accent : Colors.grey[700],
              fontWeight: widget.isSelected ? FontWeight.w600 : FontWeight.normal,
              fontSize: 14,
            ),
          ),
        ),
      ),
    );
  }
}
