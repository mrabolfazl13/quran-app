# Modern Design System Guide

## Overview

The Quran Platform now features a modern, visually stunning design system that combines Islamic aesthetics with contemporary UI/UX patterns. This guide explains the design philosophy, components and how to use them.

## Design Philosophy

### Core Principles

1. **Sacred Content First** - The Quran text is immutable and must always be presented with respect and clarity
2. **Modern Islamic Aesthetics** - Geometric patterns inspired by Islamic art, combined with glassmorphism for depth
3. **Mobile-First Responsive** - Designed for 360px phones through 1440px desktops
4. **Accessibility Always** - WCAG AA+ contrast ratios, keyboard navigation, screen reader support
5. **Performance Conscious** - Smooth animations that don't block the main thread

## Color System

### Primary Palette (Light Mode)

- **Background**: `#faf8f5` - Warm luminous paper
- **Surface**: White with varying opacity for glass effect
- **Accent**: `#1c6a55` - Sacred emerald green
- **Gold**: `#b8860b` - Luminous gold for sacred content
- **Text**: Deep ink on luminous paper (`#0f1a16`)

### Primary Palette (Dark Mode)

- **Background**: `#0a1210` - Deep cosmic space
- **Surface**: Dark teal with glass transparency
- **Accent**: `#6cc4a4` - Luminous emerald
- **Gold**: `#e8c547` - Warm gold glow
- **Text**: Luminous on dark (`#f7f4ec`)

### Semantic Colors

- **Success/OK**: Green tones matching accent
- **Warning**: Gold/yellow tones
- **Danger**: Red tones with soft backgrounds
- **Info**: Blue tones for informational states

## Glassmorphism Effects

### Usage

Glass effects add depth and modern feel to cards, panels and overlays:

```tsx
import { ModernCard } from '../ui/modern';

// Basic glass card
<ModernCard variant="glass">
  <h3>Content Here</h3>
</ModernCard>

// Elevated card (no blur)
<ModernCard variant="elevated">
  <p>Elevated content</p>
</ModernCard>

// Gradient with pattern overlay
<ModernCard variant="gradient">
  <p>Featured content</p>
</ModernCard>
```

### CSS Classes

- `.glass` - Apply backdrop-filter blur with border
- `.card-glass` - Full card with glass effect and hover lift
- `.pattern-overlay` - Adds subtle Islamic geometric pattern

## Animations

### Entrance Animations

Elements animate in smoothly when they appear:

```tsx
import { AnimatedList } from '../ui/modern';

// Items fade in with staggered delay
<AnimatedList stagger>
  {items.map(item => <Item key={item.id} {...item} />)}
</AnimatedList>
```

### Available Animations

- `fade-in-up` - Elements fade in while moving up (page transitions)
- `scale-in` - Elements scale up from 95% to 100% (cards)
- `shimmer` - Loading skeleton shimmer effect
- `pulse-glow` - Pulsing glow for active indicators
- `gradient-shift` - Animated gradient background

### Micro-interactions

- **Hover Lift**: Cards lift slightly on hover (`hover-lift` class)
- **Button Press**: Buttons scale down on press (`btn-press` class)
- **Ripple Effect**: Material Design-inspired ripple on click (`ripple` class)

## Typography

### Font Scale

All text uses fluid typography that scales with viewport:

- `--text-meta`: Metadata, badges (12px → 13.2px)
- `--text-label`: Secondary labels (13px → 14.3px)
- `--text-dense`: Dense UI text (14px → 15.4px)
- `--text-body`: Default body text (16px → 17.2px) ⭐
- `--text-strong-body`: Emphasized body (16px → 18.5px)
- `--text-section`: Section titles (18px → 21.6px)
- `--text-title`: Page titles (22px → 28.6px)
- `--text-display`: Display text (28px → 36.4px)
- `--text-hero`: Hero text (36px → 46.8px)

### Special Text

- **Gradient Text**: Use `.gradient-text` class for featured headings
- **Mushaf Text**: Uses `--mushaf-size` (2rem) with special line height for Arabic vocalization

## Components

### Modern Card

```tsx
<ModernCard variant="glass" className="my-card">
  <div className="p-4">
    <h3>Card Title</h3>
    <p>Card content with glass effect</p>
  </div>
</ModernCard>
```

Variants:
- `glass` - Backdrop blur with transparent background
- `elevated` - Shadow-based elevation
- `gradient` - With Islamic geometric pattern overlay

### Skeleton Loading

```tsx
<Skeleton width="100%" height="20px" borderRadius="var(--radius-control)" />
```

Use while content loads to reduce perceived wait time.

### Ripple Button

```tsx
<RippleButton onClick={() => console.log('clicked')}>
  Click Me
</RippleButton>
```

Provides tactile feedback on touch devices.

### Pulse Indicator

```tsx
<PulseIndicator active size="md" />
```

Shows live/active status with pulsing animation. Sizes: `sm`, `md`, `lg`.

### Gradient Text

```tsx
<GradientText>Featured Heading</GradientText>
```

Animated gradient for emphasis. Use sparingly.

## Layout Patterns

### Responsive Grid

```css
.grid--cards {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
}
```

Automatically adjusts columns based on available space.

### Safe Areas

Fixed elements respect device safe areas:

```css
padding-bottom: var(--safe-block-end); /* Bottom gesture bar */
padding-left: var(--safe-inline-start); /* Notch area */
```

## Best Practices

### Do's

✅ Use glass effects for important cards and panels
✅ Add hover-lift to interactive cards
✅ Use skeleton loading for async content
✅ Apply ripple effect to primary CTAs
✅ Use gradient text sparingly for emphasis
✅ Respect safe areas on mobile devices
✅ Maintain WCAG AA+ contrast ratios

### Don'ts

❌ Don't use more than 2-3 animated elements per screen
❌ Don't apply glass effect to everything (loses impact)
❌ Don't use gradient text for body copy
❌ Don't animate width/height properties (causes reflow)
❌ Don't rely on color alone to convey meaning
❌ Don't ignore reduced-motion preferences

## Accessibility

### Motion Preferences

All animations respect `prefers-reduced-motion`:

```css
@media (prefers-reduced-motion: reduce) {
  --dur-press: 1ms;
  --dur-1: 1ms;
  /* All animations disabled */
}
```

### Focus States

All interactive elements have visible focus rings:

```css
:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
```

### Touch Targets

Minimum 44×44px for all interactive elements (enforced by `--target`).

## Performance Tips

1. **Use transform for animations** - Never animate width/height/top/left
2. **Limit glass effects** - Use only on key surfaces, not every card
3. **Defer non-critical animations** - Use `animation-delay` for staggered lists
4. **Optimize SVG icons** - Keep paths simple, use shared Icon component
5. **Batch DOM updates** - Use React state properly to minimize reflows

## Cross-Platform Considerations

### Desktop (Tauri)

- Full glassmorphism support via WebView2
- Hover states work as expected
- Keyboard navigation essential

### Web (PWA)

- Glass effects work in modern browsers
- Provide fallback for older browsers
- Test offline functionality

### Mobile (Flutter - Phase 2)

- Implement equivalent glass effects using BackdropFilter
- Ensure touch targets meet 48dp minimum
- Support system dark/light mode switching

## Migration Guide

If updating existing screens:

1. Replace raw hex colors with semantic tokens
2. Add `hover-lift` class to interactive cards
3. Use `AnimatedList` for list rendering
4. Replace spinners with `Skeleton` components
5. Add `ripple` class to primary buttons
6. Test in both light and dark modes

## Resources

- [Design Tokens](../desktop/src/styles/tokens.css) - Complete token definitions
- [UI Components](../desktop/src/ui/primitives.tsx) - Base component library
- [Modern Components](../desktop/src/ui/modern.tsx) - New modern components
- [Icon System](../desktop/src/ui/icons.tsx) - SVG icon family

## Contributing

When adding new components:

1. Follow the established naming conventions
2. Use semantic color tokens, never raw hex values
3. Include both light and dark mode styles
4. Add proper TypeScript types
5. Document usage examples
6. Test accessibility (contrast, keyboard nav, screen readers)
