import 'dart:ui';
import 'package:flutter/material.dart';
import '../theme/app_colors.dart';

/// Modern card with glassmorphism effect
class ModernCard extends StatelessWidget {
  final Widget child;
  final VoidCallback? onTap;
  final bool elevated;
  
  const ModernCard({
    super.key,
    required this.child,
    this.onTap,
    this.elevated = false,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    
    return GestureDetector(
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(18),
          color: elevated 
              ? (isDark ? AppColors.darkSurface2 : AppColors.lightSurface2)
              : Colors.transparent,
          boxShadow: elevated
              ? [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.08),
                    blurRadius: 12,
                    offset: const Offset(0, 4),
                  ),
                ]
              : null,
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(18),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
            child: Container(
              decoration: BoxDecoration(
                color: (isDark 
                    ? AppColors.darkSurface1 
                    : AppColors.lightSurface1
                ).withOpacity(0.85),
                border: Border.all(
                  color: Colors.white.withOpacity(isDark ? 0.08 : 0.18),
                  width: 1,
                ),
                borderRadius: BorderRadius.circular(18),
              ),
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}

/// Animated list with staggered entrance
class AnimatedListWidget extends StatefulWidget {
  final List<Widget> children;
  final Duration itemDelay;
  
  const AnimatedListWidget({
    super.key,
    required this.children,
    this.itemDelay = const Duration(milliseconds: 50),
  });

  @override
  State<AnimatedListWidget> createState() => _AnimatedListWidgetState();
}

class _AnimatedListWidgetState extends State<AnimatedListWidget>
    with TickerProviderStateMixin {
  late AnimationController _controller;
  
  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 300),
      vsync: this,
    )..forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: widget.children.asMap().entries.map((entry) {
        final index = entry.key;
        final child = entry.value;
        
        return TweenAnimationBuilder<double>(
          tween: Tween(begin: 0.0, end: 1.0),
          duration: Duration(milliseconds: 300 + (index * widget.itemDelay.inMilliseconds)),
          curve: Curves.easeOutBack,
          builder: (context, value, child) {
            return Transform.translate(
              offset: Offset(0, 12 * (1 - value)),
              child: Opacity(
                opacity: value,
                child: child,
              ),
            );
          },
          child: Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: child,
          ),
        );
      }).toList(),
    );
  }
}

/// Skeleton loading placeholder
class SkeletonLoader extends StatefulWidget {
  final double width;
  final double height;
  final double borderRadius;
  
  const SkeletonLoader({
    super.key,
    this.width = double.infinity,
    this.height = 20,
    this.borderRadius = 8,
  });

  @override
  State<SkeletonLoader> createState() => _SkeletonLoaderState();
}

class _SkeletonLoaderState extends State<SkeletonLoader>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _animation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 1500),
      vsync: this,
    )..repeat();
    
    _animation = Tween<double>(begin: 0.0, end: 1.0).animate(_controller);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    
    return AnimatedBuilder(
      animation: _animation,
      builder: (context, child) {
        return Container(
          width: widget.width,
          height: widget.height,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(widget.borderRadius),
            gradient: LinearGradient(
              begin: Alignment.centerLeft,
              end: Alignment.centerRight,
              colors: [
                isDark 
                    ? AppColors.darkSurface2.withOpacity(0.6)
                    : AppColors.lightSurface2.withOpacity(0.6),
                isDark 
                    ? AppColors.darkSurface1.withOpacity(0.8)
                    : AppColors.lightSurface1.withOpacity(0.8),
                isDark 
                    ? AppColors.darkSurface2.withOpacity(0.6)
                    : AppColors.lightSurface2.withOpacity(0.6),
              ],
              stops: [_animation.value - 0.3, _animation.value, _animation.value + 0.3],
            ),
          ),
        );
      },
    );
  }
}
