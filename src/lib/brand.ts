/** Public identity. Keep storage identifiers stable when changing branding. */
import { version } from "../../package.json";

const GITHUB_USERNAME = "morilove37";
const REPOSITORY_URL = `https://github.com/${GITHUB_USERNAME}/KoiPage`;

export const BRAND = {
  name: "恋页",
  latinName: "KoiPage",
  title: "恋页 KoiPage · Galgame 管理器",
  tagline: "收藏相遇，续写下一页。",
  icon: "/brand/koipage.png",
  githubUsername: GITHUB_USERNAME,
  githubUrl: `https://github.com/${GITHUB_USERNAME}`,
  repositoryUrl: REPOSITORY_URL,
  releasesUrl: `${REPOSITORY_URL}/releases`,
  douyinName: '女友为了我变成4i',
  douyinId: 'shuiwuyueying.',
  douyinUrl: 'https://www.douyin.com/user/MS4wLjABAAAAcKXZbXNLc87TzVG6SzTXl4hUtoA0QbGgt57arDh-HxvVRSovn5fPvJvcD2mbrX8f?from_tab_name=main',
  license: 'GPL-3.0-only',
  communityGroup: '1055772679',
  version,
} as const;
