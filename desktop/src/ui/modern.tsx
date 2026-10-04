/**
 * Modern UI components with glassmorphism, smooth animations and enhanced interactions.
 * 
 * These components follow the updated design system with:
 * - Glass morphism effects for depth and modern feel
 * - Spring-based animations for natural motion
 * - Micro-interactions for tactile feedback
 * - Gradient accents for visual hierarchy
 */
import { type ReactNode, useEffect, useRef } from 'react';
import './ui.css';

export interface ModernCardProps {
  children: ReactNode;
  variant?: 'glass' | 'elevated' | 'gradient';
  className?: string;
  onClick?: () => void;
}

/**
 * A modern card with glass effect, gradient or elevated shadow.
 * Uses backdrop-filter blur for glassmorphism on supported browsers.
 */
export function ModernCard({ children, variant = 'glass', className = '', onClick }: ModernCardProps) {
  const classes = [
    variant === 'glass' ? 'card-glass' : 'card',
    variant === 'gradient' ? 'pattern-overlay' : '',
    'hover-lift',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} onClick={onClick}>
      {children}
    </div>
  );
}

export interface AnimatedListProps {
  children: ReactNode;
  stagger?: boolean;
  className?: string;
}

/**
 * A list with smooth entrance animations. Items fade in with a staggered delay.
 * Set `stagger` to true to animate items sequentially.
 */
export function AnimatedList({ children, stagger = false, className = '' }: AnimatedListProps) {
  return (
    <div className={`stagger ${className}`.trim()} data-stagger={stagger || undefined}>
      {children}
    </div>
  );
}

export interface SkeletonProps {
  width?: string;
  height?: string;
  borderRadius?: string;
  className?: string;
}

/**
 * Skeleton loading placeholder with shimmer animation.
 * Use while content is being fetched to reduce perceived load time.
 */
export function Skeleton({ width = '100%', height = '20px', borderRadius, className = '' }: SkeletonProps) {
  const style: React.CSSProperties = {
    width,
    height,
    borderRadius: borderRadius ?? 'var(--radius-control)',
  };

  return <div className={`skeleton ${className}`.trim()} style={style} />;
}

export interface RippleButtonProps {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}

/**
 * Button with Material Design-inspired ripple effect on click.
 * Provides tactile visual feedback for touch interactions.
 */
export function RippleButton({ children, onClick, className = '', disabled }: RippleButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    
    // Create ripple effect at click position
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const ripple = document.createElement('span');
    ripple.style.position = 'absolute';
    ripple.style.borderRadius = '50%';
    ripple.style.background = 'rgba(255, 255, 255, 0.6)';
    ripple.style.transform = 'scale(0)';
    ripple.style.animation = 'ripple-effect 0.6s linear';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ripple.style.width = '20px';
    ripple.style.height = '20px';
    ripple.style.marginLeft = '-10px';
    ripple.style.marginTop = '-10px';
    ripple.style.pointerEvents = 'none';

    button.appendChild(ripple);

    setTimeout(() => {
      ripple.remove();
    }, 600);

    onClick?.();
  };

  return (
    <button
      ref={buttonRef}
      className={`btn btn--primary ripple ${className}`.trim()}
      onClick={handleClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

// Add ripple animation keyframes dynamically
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes ripple-effect {
      to {
        transform: scale(4);
        opacity: 0;
      }
    }
  `;
  document.head.appendChild(style);
}

export interface GradientTextProps {
  children: ReactNode;
  className?: string;
}

/**
 * Text with animated gradient background. Use sparingly for emphasis.
 */
export function GradientText({ children, className = '' }: GradientTextProps) {
  return (
    <span className={`gradient-text ${className}`.trim()}>
      {children}
    </span>
  );
}

export interface PulseIndicatorProps {
  active?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Pulsing indicator dot for live/active status.
 */
export function PulseIndicator({ active = true, size = 'md', className = '' }: PulseIndicatorProps) {
  const sizeMap = {
    sm: '8px',
    md: '12px',
    lg: '16px',
  };

  const style: React.CSSProperties = {
    width: sizeMap[size],
    height: sizeMap[size],
    borderRadius: '50%',
    backgroundColor: active ? 'var(--accent)' : 'var(--text-muted)',
  };

  return (
    <span
      className={`pulse-glow ${className}`.trim()}
      style={style}
      aria-hidden="true"
    />
  );
}
