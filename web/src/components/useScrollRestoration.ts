import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// 画面ごとのスクロール位置。戻る(POP)は履歴エントリ単位、下部ナビでの再訪はルートタブ単位で復元する
const byKey = new Map<string, number>();
const byTab = new Map<string, number>();
const TAB_PATHS = new Set(['/', '/records', '/plans', '/health', '/more']);

/** AppShell 内で 1 回呼ぶ。ホーム→詳細→戻る でホームの位置を保つ */
export function useScrollRestoration(): void {
  const loc = useLocation();
  const type = useNavigationType();
  const cur = useRef({ key: loc.key, path: loc.pathname });

  // スクロール中は現在の画面の位置を記録
  useEffect(() => {
    const onScroll = () => {
      byKey.set(cur.current.key, window.scrollY);
      if (TAB_PATHS.has(cur.current.path)) byTab.set(cur.current.path, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    cur.current = { key: loc.key, path: loc.pathname };
    const target =
      type === 'POP' ? byKey.get(loc.key) : TAB_PATHS.has(loc.pathname) ? byTab.get(loc.pathname) : undefined;
    if (!target) {
      window.scrollTo(0, 0);
      return;
    }
    // 非同期で内容が伸びるため、高さが足りるまで少し待って再試行
    let n = 0;
    let raf = 0;
    const tryRestore = () => {
      window.scrollTo(0, target);
      if (Math.abs(window.scrollY - target) > 2 && n++ < 40) raf = requestAnimationFrame(tryRestore);
    };
    tryRestore();
    return () => cancelAnimationFrame(raf);
  }, [loc.key, loc.pathname, type]);
}
