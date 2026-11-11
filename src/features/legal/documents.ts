import privacy from '../../../docs/legal/privacy-policy.md?raw';
import terms from '../../../docs/legal/friends-terms.md?raw';
import crossBorder from '../../../docs/legal/cross-border.md?raw';
import thirdParties from '../../../docs/legal/third-party-services.md?raw';

export const LEGAL_DOCUMENTS = {
  privacy: {title: '隐私政策', content: privacy},
  terms: {title: '好友内测服务协议', content: terms},
  crossBorder: {title: '个人信息出境告知与单独同意', content: crossBorder},
  thirdParties: {title: '第三方服务与数据处理清单', content: thirdParties},
} as const;
export type LegalDocumentId = keyof typeof LEGAL_DOCUMENTS;
