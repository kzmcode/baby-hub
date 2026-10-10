import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useToast } from './Toast';

/** 新バージョン検出時に「更新があります」トーストを出す（registerType: 'prompt'） */
export function UpdatePrompt() {
  const toast = useToast();
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // 1 時間ごとに更新確認
      if (reg) setInterval(() => void reg.update(), 60 * 60 * 1000);
    },
  });
  useEffect(() => {
    if (needRefresh) {
      toast.show('更新があります', {
        duration: 0,
        action: { label: '更新する', onClick: () => void updateServiceWorker(true) },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needRefresh]);
  return null;
}
