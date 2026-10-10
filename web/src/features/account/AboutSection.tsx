import { Card } from '../../components';
import { SubPage } from './SubPage';

export const APP_VERSION = '0.1.0';

export function AboutSection() {
  return (
    <SubPage title="アプリ情報">
      <Card className="stack">
        <p>Baby hub バージョン {APP_VERSION}</p>
        <h2>プライバシーの要点</h2>
        <ul className="small">
          <li>広告 SDK、行動追跡、外部への販売は行いません。</li>
          <li>記録や健康情報を第三者の AI サービスへ送信しません。</li>
          <li>データは家族のメンバーだけが閲覧でき、保存先は日本（東京）リージョンの Firebase です。</li>
          <li>通知のロック画面表示に、子どもの名前・症状・薬名は含めません。</li>
          <li>データの出力、退出、アカウント・家族データの削除は「その他」からいつでも行えます。</li>
          <li>診断や服薬量の判断は行いません。医療上の判断は医師・薬剤師などにご相談ください。</li>
        </ul>
      </Card>
    </SubPage>
  );
}
