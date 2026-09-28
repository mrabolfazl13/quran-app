/**
 * Route resolution, in particular the two rules the sidebar depends on: every
 * registered path answers for itself and nothing else, and an unregistered path
 * is a miss so `App` can show its not-found state.
 *
 * The first version of `match` allowed a pattern shorter than the path, which
 * made `/` the home page for the entire app — `#/hifz` rendered home. That is
 * what the "root matches only root" case below exists to keep from coming back.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentType } from 'react';
import { parseHash, resolveRoute, type RouteDef, type RouteProps } from './router';

const screen = (() => null) as unknown as ComponentType<RouteProps>;

const route = (path: string): RouteDef => ({
  path,
  title: () => path,
  section: path.split('/')[1] ?? 'root',
  component: screen,
});

// The real registry's shape: one root route, then two- and three-segment paths,
// some literal and some parameterised.
const ROUTES: readonly RouteDef[] = [
  route('/'),
  route('/quran'),
  route('/quran/surah/:number'),
  route('/quran/ayah/:verseKey'),
  route('/quran/page/:pageNumber'),
  route('/hifz'),
  route('/hifz/session'),
  route('/hifz/session/:id'),
  route('/discover'),
  route('/me'),
  route('/me/content'),
];

const resolved = (path: string) => resolveRoute(ROUTES, path, {});

describe('resolveRoute', () => {
  it('root matches root and nothing else', () => {
    expect(resolved('/').route?.path).toBe('/');
    for (const path of ['/hifz', '/discover', '/quran', '/me', '/quran/page/604']) {
      expect(resolved(path).route?.path, `${path} must not fall through to home`).not.toBe('/');
    }
  });

  it('resolves each single-segment section to its own screen', () => {
    expect(resolved('/hifz').route?.path).toBe('/hifz');
    expect(resolved('/discover').route?.path).toBe('/discover');
    expect(resolved('/quran').route?.path).toBe('/quran');
    expect(resolved('/me').route?.path).toBe('/me');
    expect(resolved('/me/content').route?.path).toBe('/me/content');
  });

  it('captures parameters, including a verse key with a colon in it', () => {
    const ayah = resolved('/quran/ayah/2:255');
    expect(ayah.route?.path).toBe('/quran/ayah/:verseKey');
    expect(ayah.params).toEqual({ verseKey: '2:255' });

    const page = resolved('/quran/page/604');
    expect(page.params).toEqual({ pageNumber: '604' });
  });

  it('prefers the deeper pattern, so a literal segment is not hidden by its parent', () => {
    expect(resolved('/hifz/session').route?.path).toBe('/hifz/session');
    expect(resolved('/hifz/session/abc-1').route?.path).toBe('/hifz/session/:id');
    expect(resolved('/hifz/session/abc-1').params).toEqual({ id: 'abc-1' });
  });

  it('prefers a literal over a parameter at the same depth', () => {
    const withLiteral = [...ROUTES, route('/quran/page/first')];
    expect(resolveRoute(withLiteral, '/quran/page/first', {}).route?.path).toBe('/quran/page/first');
    expect(resolveRoute(withLiteral, '/quran/page/12', {}).route?.path).toBe('/quran/page/:pageNumber');
  });

  it('misses unknown paths in both directions', () => {
    expect(resolved('/nope').route).toBeNull();
    expect(resolved('/quran/ayah/2:255/extra').route).toBeNull();
    expect(resolved('/quran/surah').route).toBeNull();
  });
});

describe('parseHash', () => {
  it('splits path and query and decodes nothing it should not', () => {
    expect(parseHash('#/quran/ayah/2%3A255?tab=tafsir')).toEqual({
      path: '/quran/ayah/2%3A255',
      query: { tab: 'tafsir' },
    });
    expect(resolveRoute(ROUTES, parseHash('#/quran/ayah/2%3A255').path, { tab: 'tafsir' }).params)
      .toEqual({ verseKey: '2:255' });
  });

  it('treats an empty hash as the root', () => {
    expect(parseHash('')).toEqual({ path: '/', query: {} });
    expect(parseHash('#')).toEqual({ path: '/', query: {} });
    expect(parseHash('#/me/')).toEqual({ path: '/me', query: {} });
  });
});
