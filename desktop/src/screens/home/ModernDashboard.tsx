/**
 * Modern Dashboard - Showcases the new design system with glassmorphism,
 * smooth animations and enhanced visual hierarchy.
 * 
 * This is a reference implementation that other screens can learn from.
 */
import { useEffect, useState } from 'react';
import { useGateway } from '../../app/app-state';
import { Button } from '../../ui/primitives';
import { IconBookOpen, IconMoon, IconCompass, IconChart } from '../../ui/icons';
import { ModernCard, AnimatedList, PulseIndicator, Skeleton } from '../../ui/modern';
import './modern-dashboard.css';

interface DashboardStats {
  hifzActive: number;
  hifzDueToday: number;
  hifzWeak: number;
  confusionGroups: number;
  recallAttempts: number;
  hasContent: boolean;
  hasUserData: boolean;
}

export function ModernDashboard() {
  const gateway = useGateway();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      try {
        const data = await gateway.homeStats(new Date());
        if (!cancelled) {
          setStats({
            hifzActive: data.hifzActive ?? 0,
            hifzDueToday: data.hifzDueToday ?? 0,
            hifzWeak: data.hifzWeak ?? 0,
            confusionGroups: data.confusionGroups ?? 0,
            recallAttempts: data.recallAttempts ?? 0,
            hasContent: data.hasContent ?? false,
            hasUserData: data.hasUserData ?? false,
          });
          setLoading(false);
        }
      } catch (error) {
        console.error('Failed to load stats:', error);
        if (!cancelled) setLoading(false);
      }
    }

    loadStats();
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  if (loading) {
    return (
      <div className="dashboard-modern">
        <div className="dashboard-header">
          <Skeleton width="40%" height="32px" />
          <Skeleton width="60%" height="16px" />
        </div>
        <div className="stats-grid">
          {[1, 2, 3, 4].map((i) => (
            <ModernCard key={i} variant="glass">
              <div className="stat-card">
                <Skeleton width="48px" height="48px" borderRadius="50%" />
                <Skeleton width="80%" height="24px" />
                <Skeleton width="60%" height="16px" />
              </div>
            </ModernCard>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-modern pattern-overlay">
      <header className="dashboard-header page-enter">
        <h1 className="t-title gradient-text">پلتفرم قرآن</h1>
        <p className="t-body muted">یادگیری، فهم و حفظ قرآن کریم</p>
      </header>

      <AnimatedList stagger className="stats-grid">
        {/* Hifz Active Card */}
        <ModernCard variant="glass" className="card-enter">
          <div className="stat-card">
            <div className="stat-icon stat-icon--accent">
              <IconMoon size={32} />
              <PulseIndicator active={stats?.hifzActive ? stats.hifzActive > 0 : false} size="sm" />
            </div>
            <div className="stat-value num">{stats?.hifzActive ?? 0}</div>
            <div className="stat-label t-label">آیات فعال حفظ</div>
            <div className="stat-subtitle muted">
              {stats?.hifzDueToday ?? 0} مرور امروز
            </div>
          </div>
        </ModernCard>

        {/* Weak Items Card */}
        <ModernCard variant="glass" className="card-enter">
          <div className="stat-card">
            <div className="stat-icon stat-icon--gold">
              <IconChart size={32} />
            </div>
            <div className="stat-value num">{stats?.hifzWeak ?? 0}</div>
            <div className="stat-label t-label">نیاز به تمرین</div>
            <div className="stat-subtitle muted">
              {stats?.confusionGroups ?? 0} گروه متشابه
            </div>
          </div>
        </ModernCard>

        {/* Quick Actions */}
        <ModernCard variant="elevated" className="card-enter">
          <div className="action-card">
            <h3 className="t-section">دسترسی سریع</h3>
            <div className="action-buttons">
              <Button variant="primary" icon={<IconBookOpen size={20} />} block>
                مطالعه قرآن
              </Button>
              <Button variant="default" icon={<IconMoon size={20} />} block>
                جلسه حفظ
              </Button>
              <Button variant="ghost" icon={<IconCompass size={20} />} block>
                جستجو و کاوش
              </Button>
            </div>
          </div>
        </ModernCard>

        {/* Progress Overview */}
        <ModernCard variant="gradient" className="card-enter">
          <div className="progress-card">
            <div className="progress-header">
              <IconChart size={24} />
              <h3 className="t-section">پیشرفت کلی</h3>
            </div>
            <div className="progress-stats">
              <div className="progress-item">
                <span className="progress-label">تلاش‌های یادآوری</span>
                <span className="progress-value num">{stats?.recallAttempts ?? 0}</span>
              </div>
              <div className="progress-item">
                <span className="progress-label">محتوا</span>
                <span className="progress-value num">{stats?.hasContent ? '✓' : '✗'}</span>
              </div>
            </div>
          </div>
        </ModernCard>
      </AnimatedList>
    </div>
  );
}
